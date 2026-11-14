# llm-toolkit-playground

[![pages](https://github.com/Rafaelcarvalho320/llm-toolkit-playground/actions/workflows/pages.yml/badge.svg)](https://github.com/Rafaelcarvalho320/llm-toolkit-playground/actions/workflows/pages.yml)
[![ci](https://github.com/Rafaelcarvalho320/llm-toolkit-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/Rafaelcarvalho320/llm-toolkit-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Um playground no navegador para cinco bibliotecas Python que escrevi para quem
integra LLMs. O Python roda na própria página, com
[Pyodide](https://pyodide.org/) (CPython compilado para WebAssembly). Não tem
servidor: nada do que se digita sai do navegador.

**Ao vivo:** https://rafaelcarvalho320.github.io/llm-toolkit-playground/

> *[English summary below](#english-summary)*

## As quatro abas

| Aba | Biblioteca | O que dá para ver |
| --- | --- | --- |
| JSON quebrado | [llm-json](https://github.com/Rafaelcarvalho320/llm-json) | Uma resposta com texto em volta, vírgula sobrando, comentários, sintaxe de Python ou cortada no meio vira JSON, com a lista de cada reparo feito. Quando a resposta veio cortada, a página avisa que faltam campos. |
| Dados pessoais | [pii-mask](https://github.com/Rafaelcarvalho320/pii-mask) | CPF, CNPJ, cartão, telefone e e-mail trocados por tokens antes de ir ao modelo e devolvidos depois. Mostra também os números que **parecem** CPF, mas falham no dígito verificador e por isso ficam intactos. |
| Streaming | [fake-llm](https://github.com/Rafaelcarvalho320/fake-llm) + [sse-reader](https://github.com/Rafaelcarvalho320/sse-reader) | O fake responde HTTP 429 com `Retry-After`, depois transmite a resposta em SSE, picotada no meio de caracteres acentuados. Os mesmos bytes passam por um leitor comum, que quebra, e pelo `sse-reader`, que lê tudo. |
| Conferência de CSV | [reconciliation-report](https://github.com/Rafaelcarvalho320/reconciliation-report) | Dois CSVs colados (vírgula ou ponto e vírgula), uma chave e os campos a comparar. Normaliza antes (`1.234,50` = `1234.5`, `José` = `JOSE`) e lista o que diverge, o que falta de cada lado, chaves repetidas e linhas sem chave. |

## Como funciona

```
GitHub Actions (a cada push)
  ├─ pip wheel das 5 bibliotecas, nos commits fixados em requirements.txt
  └─ publica site/ + wheels/ no GitHub Pages

Navegador
  ├─ carrega o Pyodide da jsDelivr (Python 3.14)
  ├─ instala as 5 wheels a partir do próprio site
  └─ chama site/py/playground.py, que devolve JSON para a página
```

- **É Python de verdade, não uma reimplementação em JavaScript.** As
  bibliotecas são as mesmas, nos mesmos commits que passam nos testes de cada
  repositório. Isso só funciona porque nenhuma delas tem dependência fora da
  biblioteca padrão.
- **A ponte é fina e testada.** `site/py/playground.py` recebe e devolve
  strings JSON, então o JavaScript nunca converte objetos Python. Os mesmos
  arquivos são testados com CPython em `tests/`.
- **Versões fixadas.** As bibliotecas estão fixadas por commit em
  `requirements.txt`, e o Pyodide, por versão exata em `site/app.js`.
- **A página é HTML, CSS e JS puros**, sem framework nem build, com tema claro
  e escuro e as fontes Geist hospedadas no próprio site.

## Rodando localmente

```console
$ python -m venv .venv && . .venv/bin/activate
$ pip install -r requirements-dev.txt
$ python scripts/build_wheels.py        # gera site/wheels/
$ python -m http.server -d site 8000    # abra http://localhost:8000
```

Testes e lint:

```console
$ pytest
$ ruff check . && ruff format --check .
```

## English summary

A browser playground for five zero-dependency Python libraries for LLM
integrations. Python runs in the page through Pyodide, so there is no server and
nothing typed leaves the browser.

- **llm-json:** recovers JSON from a messy model reply and lists every repair,
  flagging truncated replies whose fields are missing.
- **pii-mask:** swaps Brazilian personal data for reversible tokens before a
  prompt leaves, and shows the look-alike numbers that fail their check digits
  and are left alone.
- **fake-llm + sse-reader:** a scripted 429 with `Retry-After`, then an SSE
  stream split mid-character. A naive reader crashes on the same bytes
  `sse-reader` decodes correctly.
- **reconciliation-report:** paste two CSVs, choose the key and fields, and get
  every divergence after normalisation, as a table, Markdown or CSV.

The libraries are installed from wheels built in CI from commits pinned in
`requirements.txt`. The bridge module in `site/py/` is tested with CPython.
Code and docstrings are in English; the sections above are in Portuguese.

## Licença

MIT. Veja [LICENSE](LICENSE).
