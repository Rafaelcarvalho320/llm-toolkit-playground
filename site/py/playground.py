"""The glue between the page and the libraries, run inside Pyodide.

Every function takes plain strings and returns a JSON string, so the
JavaScript side never has to convert Python objects and the same functions are
tested under CPython in ``tests/``. Nothing here re-implements a library: the
point of the page is to show what the libraries do, so any logic that would
hide that belongs in the library or nowhere.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

import llm_json
import pii_mask
from fake_llm import Failure, FakeAPIError, FakeLLM, Rule, Truncated, chunk_text
from fake_llm.server import awkward_pieces, chunk_body, final_chunk_body
from pii_mask.vault import DIGEST_LENGTH, PREFIX, Style, Vault
from reconciler import Schema, SchemaError, as_csv, as_markdown, format_key, reconcile
from sse_reader import iter_json


def _dump(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


# -- llm-json --------------------------------------------------------------


def repair_json(text: str) -> str:
    """The first JSON value in a model's reply, and every repair it needed."""
    try:
        found = llm_json.extract(text)
    except llm_json.JSONNotFound:
        return _dump({"found": False})
    total = sum(1 for _ in llm_json.extract_all(text))
    return _dump(
        {
            "found": True,
            "value": json.dumps(found.value, ensure_ascii=False, indent=2),
            "text": found.text,
            "span": found.span,
            "repairs": list(found.repairs),
            "clean": found.clean,
            "truncated": found.truncated,
            "others": max(0, total - 1),
        }
    )


# -- pii-mask --------------------------------------------------------------

_TOKEN = re.compile(rf"{PREFIX}[0-9A-F]{{{DIGEST_LENGTH}}}")

#: The vault from the last :func:`mask_pii` call. The page masks first and
#: unmasks the "model reply" afterwards, and the vault is what connects the two.
_vault: Vault | None = None


def _segments(text: str, marks: list[tuple[int, int, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Split text into plain and marked runs, for highlighting on the page."""
    out: list[dict[str, Any]] = []
    cursor = 0
    for start, end, info in sorted(marks, key=lambda mark: mark[0]):
        if start > cursor:
            out.append({"text": text[cursor:start]})
        out.append({"text": text[start:end], **info})
        cursor = end
    if cursor < len(text):
        out.append({"text": text[cursor:]})
    return out


def mask_pii(text: str, style: str = "token", include_cep: bool = False) -> str:
    """Mask the text, and show what was left alone on purpose."""
    global _vault
    detectors = pii_mask.ALL if include_cep else pii_mask.DEFAULT
    masked, vault = pii_mask.mask(text, detectors=detectors, style=Style(style))
    _vault = vault

    findings = sorted(vault.findings, key=lambda finding: finding.start)
    marks = []
    shift = 0
    for finding in findings:
        start = finding.start + shift
        end = start + len(finding.replacement)
        marks.append((start, end, {"kind": finding.kind, "original": finding.value}))
        shift += len(finding.replacement) - (finding.end - finding.start)

    # What a bare regex would also have masked. Only the check digits keep
    # these out, and showing them is the clearest way to say why that matters.
    taken = [(finding.start, finding.end) for finding in findings]
    rejected: dict[tuple[int, int], dict[str, Any]] = {}
    for detector in detectors:
        for match in detector.pattern.finditer(text):
            span = (match.start(), match.end())
            if detector.validate(match.group(0)):
                continue
            if any(start < span[1] and span[0] < end for start, end in taken):
                continue
            entry = rejected.setdefault(span, {"value": match.group(0).strip(), "kinds": []})
            if detector.kind not in entry["kinds"]:
                entry["kinds"].append(detector.kind)

    return _dump(
        {
            "masked": masked,
            "segments": _segments(masked, marks),
            "findings": [
                {"kind": f.kind, "value": f.value, "replacement": f.replacement} for f in findings
            ],
            "rejected": [rejected[span] for span in sorted(rejected)],
            "kinds": vault.kinds,
            "reversible": style == "token",
        }
    )


def unmask_reply(reply: str) -> str:
    """Put the masked values back into a reply, and say what did not come back."""
    if _vault is None:
        return _dump({"error": "nothing has been masked yet"})
    kind_of = {f.replacement: f.kind for f in _vault.findings}
    restored = _vault.unmask(reply)

    marks = []
    shift = 0
    for match in _TOKEN.finditer(reply):
        token = match.group(0)
        if token not in _vault.tokens:
            continue
        value = _vault.tokens[token]
        start = match.start() + shift
        marks.append(
            (start, start + len(value), {"kind": kind_of.get(token, "pii"), "original": token})
        )
        shift += len(value) - len(token)

    return _dump(
        {
            "text": restored,
            "segments": _segments(restored, marks),
            "missing": [
                {"token": token, "kind": kind_of.get(token, "pii")}
                for token in _vault.missing(reply)
            ],
            "leaked": [f.kind for f in _vault.leaked(reply)],
        }
    )


# -- fake-llm + sse-reader ---------------------------------------------------

PROMPT = "Previsão do tempo para Belém"


def _visible(chunk: bytes) -> str:
    return chunk.decode("utf-8", "backslashreplace").replace("\r", "\\r").replace("\n", "\\n")


def _splits_a_character(chunk: bytes) -> bool:
    try:
        chunk.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def _naive_reader(chunks: list[bytes]) -> tuple[list[str], dict[str, Any] | None]:
    """The reader almost everybody writes first: decode each chunk, split lines."""
    text = ""
    states: list[str] = []
    error: dict[str, Any] | None = None
    for index, chunk in enumerate(chunks):
        if error is None:
            try:
                for line in chunk.decode("utf-8").split("\n"):
                    if not line.startswith("data: "):
                        continue
                    payload = line[len("data: ") :]
                    if payload.strip() == "[DONE]":
                        break
                    delta = json.loads(payload)["choices"][0]["delta"]
                    text += delta.get("content") or ""
            except (UnicodeDecodeError, ValueError, KeyError) as exc:
                error = {"chunk": index, "type": type(exc).__name__, "message": str(exc)}
        states.append(text)
    return states, error


def _sse_reader(chunks: list[bytes]) -> tuple[list[str], str | None]:
    """The same bytes through sse-reader, recording the text after each chunk."""
    at = [0]

    def feed():
        for index, chunk in enumerate(chunks):
            at[0] = index
            yield chunk

    reached: dict[int, str] = {}
    text = ""
    finish: str | None = None
    for payload in iter_json(feed()):
        choice = payload["choices"][0]
        text += choice["delta"].get("content") or ""
        finish = choice.get("finish_reason") or finish
        reached[at[0]] = text

    states: list[str] = []
    current = ""
    for index in range(len(chunks)):
        current = reached.get(index, current)
        states.append(current)
    return states, finish


def stream_demo(
    reply: str,
    rate_limit: bool = True,
    truncate: bool = False,
    awkward: bool = True,
    crlf: bool = False,
) -> str:
    """Script a model with fake-llm, stream it as SSE, read it two ways."""
    script: list[Any] = []
    if rate_limit:
        script.append(Failure(429, retry_after=1, code="rate_limit_exceeded"))
    script.append(Truncated(reply, at=max(1, len(reply) * 3 // 5)) if truncate else reply)
    fake = FakeLLM([Rule(None, script)])

    attempts: list[dict[str, Any]] = []
    completion = None
    for number in range(1, 4):
        try:
            response = fake.resolve(PROMPT, {}, stream=True)
            completion = fake.to_completion(response, PROMPT)
        except FakeAPIError as exc:
            attempts.append(
                {
                    "n": number,
                    "status": exc.status,
                    "retry_after": exc.retry_after,
                    "code": exc.code,
                }
            )
            continue
        attempts.append({"n": number, "status": 200})
        break
    assert completion is not None

    newline = "\r\n" if crlf else "\n"
    response_id = fake.next_id()
    bodies = [
        chunk_body(response_id, completion.model, delta) for delta in chunk_text(completion.text)
    ]
    bodies.append(final_chunk_body(response_id, completion.model, completion.finish_reason))
    events = [
        f"data: {json.dumps(body, ensure_ascii=False)}{newline}{newline}".encode()
        for body in bodies
    ]
    events.append(f"data: [DONE]{newline}{newline}".encode())
    chunks = [
        piece for event in events for piece in (awkward_pieces(event) if awkward else [event])
    ]

    naive, naive_error = _naive_reader(chunks)
    correct, finish = _sse_reader(chunks)
    usage = fake.usage
    return _dump(
        {
            "attempts": attempts,
            "chunks": [
                {"text": _visible(c), "bytes": len(c), "split": _splits_a_character(c)}
                for c in chunks
            ],
            "events": len(events),
            "naive": naive,
            "naive_error": naive_error,
            "correct": correct,
            "finish_reason": finish,
            "expected": completion.text,
            "usage": {"prompt": usage.prompt_tokens, "completion": usage.completion_tokens},
        }
    )


# -- reconciliation-report ---------------------------------------------------


def _rows(text: str) -> tuple[list[str], list[dict[str, Any]]]:
    sample = text.strip()
    if not sample:
        return [], []
    try:
        dialect = csv.Sniffer().sniff(sample.splitlines()[0], delimiters=",;\t")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.DictReader(io.StringIO(sample), delimiter=delimiter)
    rows = []
    for row in reader:
        row.pop(None, None)
        rows.append(row)
    return list(reader.fieldnames or []), rows


def csv_columns(text: str) -> str:
    return _dump(_rows(text)[0])


def reconcile_csv(left: str, right: str, left_name: str, right_name: str, config: str) -> str:
    """Reconcile two pasted CSVs. ``config`` is ``{"key": [...], "compare": [...]}``."""
    options = json.loads(config)
    left_columns, left_rows = _rows(left)
    right_columns, right_rows = _rows(right)
    left_name = left_name.strip() or "A"
    right_name = right_name.strip() or "B"
    if left_name == right_name:
        right_name += " (2)"
    try:
        schema = Schema.build(
            key=options["key"],
            compare=[field["name"] for field in options["compare"]],
            normalizers={
                field["name"]: field["normalizer"]
                for field in [*options["compare"], *options.get("key_normalizers", [])]
                if field.get("normalizer")
            },
            tolerances={
                field["name"]: field["tolerance"]
                for field in options["compare"]
                if field.get("tolerance") not in (None, "")
            },
        )
    except (SchemaError, KeyError, ValueError, ArithmeticError) as exc:
        return _dump({"error": str(exc)})

    result = reconcile(left_rows, right_rows, schema, left_name=left_name, right_name=right_name)
    return _dump(
        {
            "names": [left_name, right_name],
            "columns": [left_columns, right_columns],
            "totals": [result.total_left, result.total_right],
            "matched": result.matched,
            "clean": result.is_clean,
            "problems": result.problem_count,
            "only_left": result.only_left,
            "only_right": result.only_right,
            "mismatches": [
                {
                    "key": format_key(m.key),
                    "differences": [
                        {"field": d.field, "left": d.left, "right": d.right} for d in m.differences
                    ],
                }
                for m in result.mismatched
            ],
            "duplicates": [
                {"side": side, "key": format_key(key), "count": count}
                for side, found in (
                    (left_name, result.duplicate_left),
                    (right_name, result.duplicate_right),
                )
                for key, count in found.items()
            ],
            "unkeyed": [
                {"side": side, "reason": item.reason, "record": item.record}
                for side, found in (
                    (left_name, result.unkeyed_left),
                    (right_name, result.unkeyed_right),
                )
                for item in found
            ],
            "markdown": as_markdown(result),
            "csv": as_csv(result),
        }
    )
