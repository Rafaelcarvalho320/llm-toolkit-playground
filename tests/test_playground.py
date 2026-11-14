import json

import playground


def call(function, *args):
    return json.loads(function(*args))


def test_repair_reports_every_repair_and_the_truncation():
    out = call(playground.repair_json, '```json\n{"a": True, // note\n "b": [1,],\n "c":')
    assert out["found"] and out["truncated"]
    assert json.loads(out["value"]) == {"a": True, "b": [1]}
    assert out["repairs"][0] == "unfenced"
    assert "closed-truncation" in out["repairs"]


def test_repair_without_json_says_so():
    assert call(playground.repair_json, "no braces here") == {"found": False}


def test_mask_keeps_numbers_that_fail_the_check_digits():
    text = "CPF 529.982.247-25, antigo 111.444.777-00, pedido 12345678901"
    out = call(playground.mask_pii, text)
    assert out["kinds"] == {"cpf": 1}
    assert "529.982.247-25" not in out["masked"]
    rejected = {item["value"] for item in out["rejected"]}
    assert rejected == {"111.444.777-00", "12345678901"}
    assert "".join(s["text"] for s in out["segments"]) == out["masked"]


def test_unmask_restores_tokens_and_lists_the_ones_the_reply_dropped():
    out = call(playground.mask_pii, "CPF 529.982.247-25, email maria@exemplo.com.br")
    cpf = next(f["replacement"] for f in out["findings"] if f["kind"] == "cpf")
    back = call(playground.unmask_reply, f"Atualizei o CPF {cpf}.")
    assert back["text"] == "Atualizei o CPF 529.982.247-25."
    assert [m["kind"] for m in back["missing"]] == ["email"]
    assert back["leaked"] == []


def test_partial_style_is_not_reversible():
    out = call(playground.mask_pii, "CPF 529.982.247-25", "partial")
    assert out["reversible"] is False
    assert out["masked"].endswith("47-25")


def test_stream_retries_after_429_and_only_the_naive_reader_breaks():
    reply = "Olá, João! Chuva em Belém à tarde."
    out = call(playground.stream_demo, reply, True, False, True, False)
    assert [a["status"] for a in out["attempts"]] == [429, 200]
    assert out["attempts"][0]["retry_after"] == 1
    assert out["correct"][-1] == reply
    assert out["finish_reason"] == "stop"
    assert out["naive_error"]["type"] == "UnicodeDecodeError"
    assert any(chunk["split"] for chunk in out["chunks"])


def test_stream_with_whole_events_reads_fine_both_ways():
    out = call(playground.stream_demo, "Olá", False, False, False, True)
    assert out["naive_error"] is None
    assert out["naive"][-1] == out["correct"][-1] == "Olá"


def test_truncated_stream_reports_length():
    out = call(playground.stream_demo, "0123456789", False, True, False, False)
    assert out["finish_reason"] == "length"
    assert out["correct"][-1] == "012345"


def test_reconcile_normalises_before_comparing():
    left = 'pedido,cliente,total\n1001,José Silva,"1.234,50"\n1002,Ana,10.00\n1002,Ana,10.00\n,X,1'
    right = "pedido;cliente;total\n1001;JOSE SILVA;1234.5\n1002;Ana;11.00\n1004;Caio;7"
    config = {
        "key": ["pedido"],
        "compare": [
            {"name": "cliente", "normalizer": "unaccented"},
            {"name": "total", "normalizer": "money", "tolerance": "0.01"},
        ],
    }
    out = call(playground.reconcile_csv, left, right, "erp", "loja", json.dumps(config))
    assert out["matched"] == 1
    assert out["mismatches"][0]["key"] == "1002"
    assert [r["pedido"] for r in out["only_right"]] == ["1004"]
    assert out["duplicates"] == [{"side": "erp", "key": "1002", "count": 2}]
    assert len(out["unkeyed"]) == 1
    assert out["markdown"].startswith("## Reconciliation")


def test_reconcile_reports_schema_errors():
    config = {"key": [], "compare": []}
    out = call(playground.reconcile_csv, "a\n1", "a\n1", "x", "y", json.dumps(config))
    assert "error" in out
