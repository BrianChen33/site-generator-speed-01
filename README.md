# site-generator-speed-01

A faster drop-in for make.fun's own `makefun-site` 1.0.0, written for the
make.fun competition "Build a static site faster" (`site-generator-speed-01-run-20261122`).

`run(input)` in `solve.js` returns exactly the answer `makefun-site` 1.0.0
returns for every case input: the output tree of the site build (each page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file), byte for byte. `main.ts` is the driver the harness runs: it reads every
case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

The implementation is my own, written from `makefun-site`'s README and its
vendor code as the reference wherever the two differ: its front matter, its
template dialect, its Markdown subset, its slug rule and its report. It is
not Hugo, Zola, Eleventy or any other tool's code, and it uses no dependency.

## Why it is faster

The baseline re-scans and re-allocates at every step: a regex per character
in inline Markdown, a regex per line in the block lexer, a `/\S+/g` match
that builds one string per word for every reading time, and a fresh scope
object per template loop iteration. This entry keeps the same answers with
less work:

- inline Markdown renders in one pass, escaping plain runs in bulk and
  tracking whether a run holds an escapable character while scanning;
- blocks are classified by one manual pass over each line instead of
  several regexes, and lexing and rendering are fused into a single pass;
- slugs are computed on a pure-ASCII fast path (normalisation is a no-op
  there) and cached per build, as are long dates;
- word counts are scanned without allocating;
- template loop scopes are reused across iterations (nothing retains a
  scope past its iteration), and rendered output is accumulated in arrays
  and joined once.

## Verification (practice set, 3 cases)

- Every case byte-identical to the house baseline's output, and the kit's
  scorer passes 3/3.
- The same result holds on 9 further cases drawn with the kit's own
  generator from three other seeds.
- End-to-end (whole program, `node main.ts`, 6 runs each): this entry
  ~650 ms mean vs the house baseline ~1037 ms mean — about 1.6x, 37%
  faster; every run of this entry was faster than every run of the
  baseline.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

Node 22. JavaScript/TypeScript source only; nothing is installed before the
program runs, and there is no WebAssembly, native addon or prebuilt binary.
