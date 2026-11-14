// LLM Toolkit Playground. Loads CPython (Pyodide) in the page, installs the
// five libraries from wheels built at deploy time, and calls site/py/playground.py.
// No framework and no build step.

// Served from this origin (scripts/vendor_pyodide.py), so the page runs no
// third-party code and its CSP can forbid every other origin.
const PYODIDE_URL = new URL("pyodide/pyodide.mjs", location.href).href;

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, size = 15) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
const badge = (tone, ic, text) => `<span class="badge ${tone}">${icon(ic)}${text}</span>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// -- theme and nav -------------------------------------------------------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const effectiveTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");
function syncTheme() {
  const dark = effectiveTheme() === "dark";
  $("theme").innerHTML = icon(dark ? "sun" : "moon", 17);
  $("theme").setAttribute("aria-label", dark ? "Usar tema claro" : "Usar tema escuro");
  document.querySelector('meta[name="theme-color"]').content = dark ? "#09090b" : "#fafafa";
}
$("theme").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* private mode */ }
  syncTheme();
});
darkQuery.addEventListener("change", syncTheme);
syncTheme();

const nav = document.querySelector(".nav");
window.addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

// -- tabs ----------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
  history.replaceState(null, "", `#${tab.id.slice(4)}`);
  tab.scrollIntoView({ block: "nearest", inline: "nearest" });
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (ev) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (step) { ev.preventDefault(); selectTab(tabs[(i + step + tabs.length) % tabs.length], true); }
    if (ev.key === "Home") { ev.preventDefault(); selectTab(tabs[0], true); }
    if (ev.key === "End") { ev.preventDefault(); selectTab(tabs.at(-1), true); }
  });
});
const fromHash = tabs.find((t) => `#${t.id.slice(4)}` === location.hash);
if (fromHash) selectTab(fromHash);

function examples(target, list, onPick) {
  const root = document.querySelector(`.examples[data-for="${target}"]`);
  root.innerHTML = list.map((ex, i) => `<button class="chip" type="button" aria-pressed="${i === 0}" data-i="${i}">${esc(ex.label)}</button>`).join("");
  root.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    root.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    onPick(list[Number(chip.dataset.i)]);
  });
  return (value) => root.querySelectorAll(".chip").forEach((c) => {
    if (list[Number(c.dataset.i)].text !== value) c.setAttribute("aria-pressed", "false");
  });
}

// -- python --------------------------------------------------------------

let py = null;
const ready = [];
function call(name, ...args) {
  return JSON.parse(py.globals.get("playground")[name](...args));
}
function onReady(fn) { if (py) fn(); else ready.push(fn); }

async function boot() {
  const fill = $("boot-fill");
  const say = (pct, text) => { fill.style.width = `${pct}%`; $("boot-text").textContent = text; };
  try {
    say(12, "Baixando o Python (cerca de 10 MB, só na primeira visita)…");
    const { loadPyodide } = await import(PYODIDE_URL);
    const pyodide = await loadPyodide();
    say(70, "Instalando as cinco bibliotecas…");
    const manifest = await fetch("wheels/manifest.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`wheels/manifest.json: HTTP ${r.status}`);
      return r.json();
    });
    await pyodide.loadPackage(manifest.wheels.map((w) => new URL(`wheels/${w}`, location.href).href), { messageCallback: () => {} });
    say(90, "Preparando o playground…");
    const source = await fetch("py/playground.py", { cache: "no-cache" }).then((r) => r.text());
    pyodide.FS.writeFile("/home/pyodide/playground.py", source);
    pyodide.runPython("import sys\nif '/home/pyodide' not in sys.path: sys.path.insert(0, '/home/pyodide')\nimport playground");
    const version = pyodide.runPython("import sys; '.'.join(map(str, sys.version_info[:2]))");
    py = pyodide;
    say(100, "Pronto.");
    $("boot").classList.add("done");
    $("runtime").classList.add("ready");
    $("runtime").querySelector(".runtime-text").textContent = `Python ${version} no navegador`;
    for (const fn of ready.splice(0)) fn();
  } catch (err) {
    console.error(err);
    $("boot").classList.add("failed");
    $("boot-text").textContent = `Não foi possível carregar o Python: ${err.message || err}. Recarregue a página para tentar de novo.`;
    $("runtime").classList.add("failed");
    $("runtime").querySelector(".runtime-text").textContent = "Python indisponível";
  }
}

// -- llm-json ------------------------------------------------------------

const REPAIRS = {
  "unfenced": "Tirado do bloco <code>```json</code>",
  "removed-prose": "Texto em volta descartado",
  "normalised-quotes": "Aspas trocadas por aspas de JSON",
  "removed-comments": "Comentários removidos",
  "removed-trailing-comma": "Vírgula sobrando removida",
  "python-literals": "<code>True</code>, <code>False</code> e <code>None</code> viraram JSON",
  "closed-truncation": "Resposta cortada: fechada no último valor completo",
};

const JSON_EXAMPLES = [
  { label: "Texto e bloco de código", text: 'Claro! Segue o JSON pedido:\n\n```json\n{\n  "cliente": "Maria Souza",\n  "cidade": "Belém",\n  "itens": 3\n}\n```\n\nSe precisar de mais alguma coisa, é só pedir.' },
  { label: "Cortada no meio", text: '{"pedidos": [{"id": 1, "total": 120.5}, {"id": 2, "total": 89.9}, {"id": 3, "tot' },
  { label: "Vírgulas e comentários", text: '{\n  "modelo": "gpt-x",\n  "temperatura": 0.2, // mais determinístico\n  "tags": ["faturas", "boletos",],\n}' },
  { label: "Sintaxe de Python", text: "{'aprovado': True, 'motivo': None, 'score': 0.93}" },
  { label: "Aspas curvas", text: "{“status”: “ok”, “mensagem”: “Cadastro concluído”}" },
  { label: "Frase em volta", text: 'Analisei o pedido. Resultado: {"aprovado": false, "motivo": "CPF inválido"}. Qualquer dúvida, estou aqui.' },
];

function highlightJSON(text) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${esc(m[2])}` : `<span class="j-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-lit">${m[3]}</span>`;
    else out += `<span class="j-num">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const jsonIn = $("json-in");
jsonIn.value = JSON_EXAMPLES[0].text;
const jsonChips = examples("json", JSON_EXAMPLES, (ex) => { jsonIn.value = ex.text; runJSON(); });

function runJSON() {
  if (!py) return;
  const r = call("repair_json", jsonIn.value);
  const out = $("json-out");
  if (!r.found) {
    out.innerHTML = `${badge("critical", "x", "Nenhum JSON encontrado")}<p class="wait">Não há objeto nem lista que dê para recuperar. <code>extract()</code> levanta <code>JSONNotFound</code> em vez de devolver <code>None</code>.</p>`;
    return;
  }
  const head = r.clean
    ? badge("good", "check", "JSON válido, sem nenhum reparo")
    : r.truncated
      ? badge("warning", "alert", "Recuperado, mas a resposta veio cortada")
      : badge("info", "check", `Recuperado com ${plural(r.repairs.length, "reparo", "reparos")}`);
  const steps = r.repairs.length
    ? `<ol class="steps">${r.repairs.map((name) => `<li><span>${REPAIRS[name] || esc(name)}</span><code class="rid">${esc(name)}</code></li>`).join("")}</ol>`
    : "";
  const trunc = r.truncated
    ? `<p class="note warning"><b>Faltam campos.</b> O modelo parou no meio, e o valor abaixo é só a parte que chegou inteira. Em produção, <code>loads(texto, allow_truncated=False)</code> recusaria esta resposta.</p>`
    : "";
  const others = r.others
    ? `<p class="note info">A resposta tinha mais ${plural(r.others, "valor JSON", "valores JSON")}. <code>extract_all()</code> devolve todos.</p>`
    : "";
  out.innerHTML = `${head}${steps}${trunc}${others}<pre>${highlightJSON(r.value)}</pre>` +
    (r.clean ? "" : `<details class="sub-details"><summary>Texto entregue ao <code>json.loads</code></summary><pre>${esc(r.text)}</pre></details>`);
}
jsonIn.addEventListener("input", debounce(() => { jsonChips(jsonIn.value); runJSON(); }, 120));
onReady(runJSON);

// -- pii-mask ------------------------------------------------------------

const KIND = { cpf: "CPF", cnpj: "CNPJ", card: "Cartão", phone: "Telefone", email: "E-mail", cep: "CEP", pii: "Dado" };
const kindWord = (k) => (["cpf", "cnpj", "cep"].includes(k) ? KIND[k] : (KIND[k] || k).toLowerCase());

const PII_EXAMPLES = [
  { label: "Chamado de suporte", text: "Olá, sou a Maria Souza (CPF 529.982.247-25). Meu pedido 20241114093 não chegou. Podem me ligar no (91) 98765-4321 ou responder em maria.souza@exemplo.com.br? Paguei com o cartão 4111 1111 1111 1111. A nota saiu no CNPJ 11.222.333/0001-81, entrega no CEP 66075-110." },
  { label: "Números que enganam", text: "Protocolo 52998224726, pedido 12345678901 e boleto 111.444.777-00: nenhum deles é CPF válido. Já o CPF 52998224725, mesmo sem pontuação, é. O telefone 11 91234-5678 também." },
  { label: "Cadastro de empresa", text: "Razão social: Exemplo Comércio Ltda, CNPJ 11222333000181. Contato financeiro: financeiro@exemplo.com.br, (21) 3456-7890. Responsável: CPF 390.533.447-05." },
];

const piiIn = $("pii-in");
piiIn.value = PII_EXAMPLES[0].text;
const piiChips = examples("pii", PII_EXAMPLES, (ex) => { piiIn.value = ex.text; runPII(); });
const piiStyle = () => document.querySelector('input[name="pii-style"]:checked').value;

function segmentsHTML(segments, cls = "") {
  return segments.map((s) => s.kind
    ? `<span class="pii ${cls}" title="${esc(`${KIND[s.kind] || s.kind}: ${s.original}`)}">${esc(s.text)}</span>`
    : esc(s.text)).join("");
}

function replyFor(findings) {
  const first = (kind) => (findings.find((f) => f.kind === kind) || {}).replacement;
  const cpf = first("cpf"), phone = first("phone"), email = first("email"), card = first("card");
  const parts = ["Oi! Já verifiquei seu caso."];
  if (cpf) parts.push(`Localizei o cadastro do CPF ${cpf}.`);
  if (phone && email) parts.push(`Vou ligar para ${phone} ainda hoje e mando o comprovante para ${email}.`);
  else if (phone) parts.push(`Vou ligar para ${phone} ainda hoje.`);
  else if (email) parts.push(`Mando o comprovante para ${email}.`);
  if (card) parts.push(`O estorno vai para o cartão ${card}.`);
  if (parts.length === 1 && findings[0]) parts.push(`Registrei ${findings[0].replacement} no atendimento.`);
  return parts.join(" ");
}

function runPII() {
  if (!py) return;
  const r = call("mask_pii", piiIn.value, piiStyle(), $("pii-cep").checked);
  const n = r.findings.length;
  const head = n
    ? badge("info", "check", `${plural(n, "dado pessoal mascarado", "dados pessoais mascarados")}`)
    : badge("neutral", "check", "Nenhum dado pessoal encontrado");
  const table = n
    ? `<table class="table"><thead><tr><th>Tipo</th><th>Original</th><th>Vai como</th></tr></thead><tbody>${r.findings.map((f) =>
      `<tr><td><span class="kind">${KIND[f.kind] || esc(f.kind)}</span></td><td class="mono">${esc(f.value)}</td><td class="mono">${esc(f.replacement)}</td></tr>`).join("")}</tbody></table>`
    : "";
  const rejected = r.rejected.length
    ? `<p class="note neutral"><b>Parecem, mas não são.</b> ${r.rejected.map((x) => `<code>${esc(x.value)}</code>`).join(", ")} ${r.rejected.length === 1 ? "tem" : "têm"} formato de ${[...new Set(r.rejected.flatMap((x) => x.kinds))].map(kindWord).join(" ou ")}, mas o dígito verificador não confere. Uma regex sozinha mascararia ${r.rejected.length === 1 ? "esse número" : "esses números"} e estragaria o texto.</p>`
    : "";
  const lossy = !r.reversible && n
    ? `<p class="note warning"><b>Sem volta.</b> Rótulo e parcial servem para log. Só o token permite <code>vault.unmask()</code> na resposta.</p>`
    : "";
  $("pii-out").innerHTML = `${head}<p class="marked">${segmentsHTML(r.segments)}</p>${table}${rejected}${lossy}`;

  const round = $("pii-round");
  round.hidden = !(r.reversible && n);
  if (!round.hidden) {
    $("pii-reply").value = replyFor(r.findings);
    runUnmask();
  }
}

function runUnmask() {
  if (!py) return;
  const r = call("unmask_reply", $("pii-reply").value);
  if (r.error) { $("pii-back").innerHTML = ""; return; }
  const missing = r.missing.length
    ? `<p class="note neutral"><b>Não voltaram na resposta:</b> ${[...new Set(r.missing.map((m) => kindWord(m.kind)))].join(", ")}. É o que <code>vault.missing()</code> aponta: útil quando a resposta deveria citar todos.</p>`
    : "";
  const leaked = r.leaked.length
    ? `<p class="note critical"><b>Vazou.</b> A resposta contém o valor original de ${[...new Set(r.leaked.map(kindWord))].join(", ")}. <code>vault.leaked()</code> pega isso em teste.</p>`
    : "";
  $("pii-back").innerHTML = `<p class="marked">${segmentsHTML(r.segments, "back")}</p>${missing}${leaked}`;
}

piiIn.addEventListener("input", debounce(() => { piiChips(piiIn.value); runPII(); }, 150));
document.querySelectorAll('input[name="pii-style"]').forEach((el) => el.addEventListener("change", runPII));
$("pii-cep").addEventListener("change", runPII);
$("pii-reply").addEventListener("input", debounce(runUnmask, 120));
onReady(runPII);

// -- streaming -----------------------------------------------------------

$("stream-in").value = "Olá, João! A previsão para Belém amanhã é de chuva à tarde, com máxima de 32 °C. Leve guarda-chuva ☔";
let streamRun = 0;

async function runStream() {
  if (!py) return;
  const run = ++streamRun;
  const alive = () => run === streamRun;
  const r = call("stream_demo",
    $("stream-in").value || "Olá",
    $("stream-429").checked,
    $("stream-trunc").checked,
    document.querySelector('input[name="stream-split"]:checked').value === "awkward",
    document.querySelector('input[name="stream-nl"]:checked').value === "crlf");

  const fast = reducedMotion();
  const attempts = $("stream-attempts");
  const wire = $("stream-wire");
  const naiveText = $("naive-text"), sseText = $("sse-text");
  attempts.innerHTML = "";
  wire.innerHTML = "";
  naiveText.textContent = sseText.textContent = "";
  $("naive-foot").innerHTML = $("sse-foot").innerHTML = "";
  $("wire-meta").textContent = "";

  for (const a of r.attempts) {
    if (!alive()) return;
    const li = document.createElement("li");
    if (a.status === 200) {
      li.innerHTML = `<span class="num">#${a.n}</span>${badge("good", "check", "HTTP 200")}<span>transmitindo ${plural(r.events, "evento", "eventos")} SSE</span>`;
      attempts.appendChild(li);
    } else {
      li.innerHTML = `<span class="num">#${a.n}</span>${badge("warning", "alert", `HTTP ${a.status}`)}<span><code>${esc(a.code || "")}</code> · Retry-After: ${a.retry_after}&nbsp;s</span><span class="wait-bar"><span></span></span>`;
      attempts.appendChild(li);
      const bar = li.querySelector(".wait-bar span");
      const total = (a.retry_after || 0) * 1000;
      if (!fast && total) {
        const start = performance.now();
        while (performance.now() - start < total) {
          if (!alive()) return;
          bar.style.width = `${Math.min(100, ((performance.now() - start) / total) * 100)}%`;
          await sleep(30);
        }
      }
      bar.style.width = "100%";
    }
  }

  naiveText.classList.add("caret");
  sseText.classList.add("caret");
  const delay = fast ? 0 : Math.max(10, Math.min(55, 2400 / r.chunks.length));
  const err = r.naive_error;
  let fresh = null;
  for (let i = 0; i < r.chunks.length; i++) {
    if (!alive()) return;
    const c = r.chunks[i];
    if (fresh) fresh.classList.remove("fresh");
    fresh = document.createElement("span");
    fresh.className = `fresh${c.split ? " split" : ""}`;
    fresh.textContent = c.text;
    if (c.split) fresh.title = "Este pedaço corta um caractere UTF-8 ao meio";
    wire.appendChild(fresh);
    wire.scrollTop = wire.scrollHeight;
    $("wire-meta").textContent = `${i + 1} de ${r.chunks.length} pedaços`;
    naiveText.textContent = r.naive[i];
    sseText.textContent = r.correct[i];
    if (err && i === err.chunk) {
      naiveText.classList.remove("caret");
      $("naive-foot").innerHTML = `${badge("critical", "x", `Quebrou no pedaço ${err.chunk + 1}`)}<span class="err">${esc(err.type)}: ${esc(err.message)}</span>`;
    }
    if (delay) await sleep(delay);
  }
  if (fresh) fresh.classList.remove("fresh");
  naiveText.classList.remove("caret");
  sseText.classList.remove("caret");
  if (err && !r.naive.at(-1)) naiveText.innerHTML = '<span class="wait">Nenhuma letra chegou à tela.</span>';
  if (!err) {
    $("naive-foot").innerHTML = `${badge("good", "check", "Funcionou desta vez")}<span>Só porque cada evento chegou inteiro. A rede não garante isso.</span>`;
  }
  $("sse-foot").innerHTML = r.finish_reason === "length"
    ? `${badge("warning", "alert", "finish_reason: length")}<span>Leu tudo o que chegou, e o motivo de parada avisa que a resposta foi cortada no limite de tokens.</span>`
    : `${badge("good", "check", "finish_reason: stop")}<span>${plural(r.usage.completion, "token", "tokens")} de resposta, contados pelo fake-llm.</span>`;
}

$("stream-go").addEventListener("click", () => runStream().finally(() => { $("stream-go").disabled = false; }));
onReady(() => { $("stream-go").disabled = false; });

// -- reconciliation-report ----------------------------------------------

const CSV_EXAMPLES = [
  {
    label: "Pedidos: ERP × loja",
    names: ["erp.csv", "loja.csv"],
    left: 'pedido,cliente,cidade,total,pago\n1001,José Silva,Belém,"1.234,50",sim\n1002,Ana Costa,São Paulo,89.90,sim\n1003,Bruno Lima,Recife,450.00,não\n1003,Bruno Lima,Recife,450.00,não\n1004,Carla Dias,Manaus,"77,30",sim\n1005,Davi Rocha,Curitiba,1200.00,sim\n,Pedido sem número,Natal,10.00,não',
    right: "pedido;cliente;cidade;total;pago\n1001;JOSE SILVA;BELEM;1234.5;true\n1002;Ana Costa;São Paulo;98.90;true\n1003;Bruno Lima;Recife;450;false\n1004;Carla Dias;Manaus;77.30;true\n1006;Elisa Melo;Fortaleza;310.00;true",
  },
  {
    label: "Clientes: CRM × planilha",
    names: ["crm.csv", "planilha.csv"],
    left: "cpf,nome,email,ativo\n529.982.247-25,Maria Souza,maria@exemplo.com,sim\n111.444.777-35,João Pereira,joao@exemplo.com,sim\n390.533.447-05,Lúcia Martins,lucia@exemplo.com,não",
    right: "cpf;nome;email;ativo\n52998224725;MARIA SOUZA;maria@exemplo.com;1\n11144477735;Joao Pereira;joao.p@exemplo.com;1\n39053344705;Lucia Martins;lucia@exemplo.com;1",
  },
];
const NORMALIZERS = [
  ["unaccented", "Sem acento e sem caixa"],
  ["text", "Texto (só apara espaços)"],
  ["lower", "Minúsculas"],
  ["digits", "Só dígitos"],
  ["integer", "Número inteiro"],
  ["money", "Dinheiro (1.234,50 = 1234.5)"],
  ["date", "Data"],
  ["boolean", "Sim/não (sim = true = 1)"],
  ["identity", "Exato, sem normalizar"],
];

function guessNormalizer(name) {
  const n = name.toLowerCase();
  if (/total|valor|preco|preço|saldo|price|amount/.test(n)) return "money";
  if (/pago|ativo|active|paid|flag/.test(n)) return "boolean";
  if (/data|date|dia|venc/.test(n)) return "date";
  if (/cpf|cnpj|cep|telefone|phone|celular/.test(n)) return "digits";
  if (/qtd|quant|itens|id$/.test(n)) return "integer";
  if (/email|e-mail/.test(n)) return "lower";
  return "unaccented";
}
const normalizerSelect = (value, label) =>
  `<select aria-label="${esc(label)}">${NORMALIZERS.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("")}</select>`;

const csvLeft = $("csv-left"), csvRight = $("csv-right");
const csvState = { key: null, keyNorm: null, fields: new Map() };

function loadCSVExample(ex) {
  csvLeft.value = ex.left;
  csvRight.value = ex.right;
  $("csv-left-name").value = ex.names[0];
  $("csv-right-name").value = ex.names[1];
  csvState.key = null;
  csvState.keyNorm = null;
  csvState.fields.clear();
  rebuildSchema();
}
const csvChips = examples("csv", CSV_EXAMPLES, loadCSVExample);

function rebuildSchema() {
  if (!py) return;
  const left = call("csv_columns", csvLeft.value);
  const right = call("csv_columns", csvRight.value);
  const common = left.filter((c) => right.includes(c));
  const keySel = $("csv-key");
  if (!common.includes(csvState.key)) csvState.key = common[0] || null;
  keySel.innerHTML = common.map((c) => `<option${c === csvState.key ? " selected" : ""}>${esc(c)}</option>`).join("") || "<option value=''>sem coluna em comum</option>";
  if (!csvState.keyNorm) csvState.keyNorm = csvState.key ? (guessNormalizer(csvState.key) === "digits" ? "digits" : "text") : "text";
  $("csv-key-norm").outerHTML = normalizerSelect(csvState.keyNorm, "Normalização da chave").replace("<select", '<select id="csv-key-norm"');
  $("csv-key-norm").addEventListener("change", (ev) => { csvState.keyNorm = ev.target.value; runCSV(); });

  const fields = common.filter((c) => c !== csvState.key);
  $("csv-fields").innerHTML = fields.map((name) => {
    const st = csvState.fields.get(name) || { on: true, norm: guessNormalizer(name), tol: guessNormalizer(name) === "money" ? "0.01" : "" };
    csvState.fields.set(name, st);
    const tolerant = ["money", "integer"].includes(st.norm);
    return `<div class="fieldrow${st.on ? "" : " off"}" data-name="${esc(name)}">
      <label class="check"><input type="checkbox"${st.on ? " checked" : ""}><span>${esc(name)}</span></label><span></span>
      ${normalizerSelect(st.norm, `Normalização de ${name}`)}
      ${tolerant ? `<label class="tol">Tolerância <input type="text" inputmode="decimal" value="${esc(st.tol)}" aria-label="Tolerância de ${esc(name)}"></label>` : ""}
    </div>`;
  }).join("") || '<p class="wait">Nenhuma outra coluna em comum para comparar.</p>';
  runCSV();
}

$("csv-key").addEventListener("change", (ev) => { csvState.key = ev.target.value; csvState.keyNorm = null; rebuildSchema(); });
$("csv-fields").addEventListener("input", (ev) => {
  const row = ev.target.closest(".fieldrow");
  if (!row) return;
  const st = csvState.fields.get(row.dataset.name);
  if (ev.target.type === "checkbox") st.on = ev.target.checked;
  else if (ev.target.tagName === "SELECT") { st.norm = ev.target.value; if (st.norm === "money" && !st.tol) st.tol = "0.01"; rebuildSchema(); return; }
  else st.tol = ev.target.value;
  row.classList.toggle("off", !st.on);
  runCSVSoon();
});
const csvChanged = debounce(() => { csvChips(null); rebuildSchema(); }, 250);
[csvLeft, csvRight].forEach((el) => el.addEventListener("input", csvChanged));
[$("csv-left-name"), $("csv-right-name")].forEach((el) => el.addEventListener("input", debounce(() => runCSV(), 250)));

function recordsTable(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return `<div class="table-wrap"><table class="table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

let lastReport = null;
function runCSV() {
  if (!py) return;
  const out = $("csv-out");
  if (!csvState.key) { out.innerHTML = '<p class="note warning">Os dois arquivos precisam ter ao menos uma coluna com o mesmo nome para servir de chave.</p>'; return; }
  const compare = [...csvState.fields].filter(([, st]) => st.on).map(([name, st]) => ({ name, normalizer: st.norm, tolerance: ["money", "integer"].includes(st.norm) ? st.tol : "" }))
    .filter((f) => document.querySelector(`.fieldrow[data-name="${CSS.escape(f.name)}"]`));
  const config = { key: [csvState.key], key_normalizers: [{ name: csvState.key, normalizer: csvState.keyNorm }], compare };
  const r = call("reconcile_csv", csvLeft.value, csvRight.value, $("csv-left-name").value, $("csv-right-name").value, JSON.stringify(config));
  if (r.error) { out.innerHTML = `<p class="note critical"><b>Configuração inválida.</b> ${esc(r.error)}</p>`; return; }
  lastReport = r;
  const [a, b] = r.names;
  const diffCount = r.mismatches.reduce((n, m) => n + m.differences.length, 0);
  const tally = [
    ["Iguais", r.matched, "ok"],
    ["Divergentes", r.mismatches.length, r.mismatches.length ? "bad" : ""],
    [`Só em ${a}`, r.only_left.length, r.only_left.length ? "bad" : ""],
    [`Só em ${b}`, r.only_right.length, r.only_right.length ? "bad" : ""],
    ["Chave repetida", r.duplicates.length, r.duplicates.length ? "bad" : ""],
    ["Sem chave", r.unkeyed.length, r.unkeyed.length ? "bad" : ""],
  ];
  const cards = [];
  if (r.mismatches.length) {
    cards.push(`<div class="box finding"><h3>Divergentes <span class="count">${diffCount}</span></h3><p>Mesma chave, valores diferentes depois de normalizar.</p><div class="table-wrap"><table class="table"><thead><tr><th>${esc(csvState.key)}</th><th>Campo</th><th>${esc(a)}</th><th>${esc(b)}</th></tr></thead><tbody>${r.mismatches.flatMap((m) =>
      m.differences.map((d) => `<tr><td class="mono">${esc(m.key)}</td><td>${esc(d.field)}</td><td class="mono diff-l">${esc(d.left)}</td><td class="mono diff-r">${esc(d.right)}</td></tr>`)).join("")}</tbody></table></div></div>`);
  }
  if (r.only_left.length) cards.push(`<div class="box finding"><h3>Só em ${esc(a)} <span class="count">${r.only_left.length}</span></h3><p>A chave não existe no outro arquivo.</p>${recordsTable(r.only_left)}</div>`);
  if (r.only_right.length) cards.push(`<div class="box finding"><h3>Só em ${esc(b)} <span class="count">${r.only_right.length}</span></h3><p>A chave não existe no outro arquivo.</p>${recordsTable(r.only_right)}</div>`);
  if (r.duplicates.length) cards.push(`<div class="box finding"><h3>Chave repetida <span class="count">${r.duplicates.length}</span></h3><p>A mesma chave aparece mais de uma vez no mesmo arquivo.</p>${recordsTable(r.duplicates.map((d) => ({ arquivo: d.side, chave: d.key, vezes: d.count })))}</div>`);
  if (r.unkeyed.length) cards.push(`<div class="box finding"><h3>Sem chave <span class="count">${r.unkeyed.length}</span></h3><p>Linhas que não dá para comparar porque a chave está vazia.</p>${recordsTable(r.unkeyed.map((u) => ({ arquivo: u.side, ...u.record })))}</div>`);

  out.innerHTML = `
    <div class="verdict">
      <div class="verdict-title">${r.clean ? badge("good", "check", "Tudo confere") : badge("warning", "alert", plural(r.problems, "problema", "problemas"))}<span>${esc(a)} (${plural(r.totals[0], "linha", "linhas")}) × ${esc(b)} (${plural(r.totals[1], "linha", "linhas")})</span></div>
      <div class="verdict-actions">
        <button class="ghost" type="button" id="csv-copy">${icon("copy")}Copiar relatório em Markdown</button>
        <button class="ghost" type="button" id="csv-download">${icon("download")}Baixar CSV</button>
      </div>
    </div>
    <dl class="tally">${tally.map(([label, n, cls]) => `<div class="${cls}"><dt>${esc(label)}</dt><dd>${n}</dd></div>`).join("")}</dl>
    ${cards.length ? `<div class="findings">${cards.join("")}</div>` : '<p class="note good"><b>Nenhuma divergência.</b> Todas as chaves existem dos dois lados e os campos comparados batem.</p>'}`;

  $("csv-copy").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    try { await navigator.clipboard.writeText(lastReport.markdown); btn.lastChild.textContent = "Copiado"; }
    catch { btn.lastChild.textContent = "Não foi possível copiar"; }
    setTimeout(() => { btn.lastChild.textContent = "Copiar relatório em Markdown"; }, 1800);
  });
  $("csv-download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([lastReport.csv], { type: "text/csv;charset=utf-8" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "divergencias.csv" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
const runCSVSoon = debounce(runCSV, 200);

loadCSVExample(CSV_EXAMPLES[0]);
onReady(rebuildSchema);

boot();
