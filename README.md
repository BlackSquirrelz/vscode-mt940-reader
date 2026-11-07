# MT940 Reader

A VS Code extension that opens SWIFT MT940 bank statements (`.mt940`, `.sta`, `.940`) as
readable statements instead of raw `:61:` lines.

- One section per statement (`:20:` block): account/IBAN, statement number, opening, in, out,
  closing and available balances.
- A check per statement that opening + entries = closing, and that consecutive statements of
  the same account join up.
- Entries as a table: booking and value date, counterparty, text, IBAN found in the text, type
  code, amount. Click a row for references, the subfields and the raw lines; "line N" opens the
  text beside it at that line.
- Swiss `:86:` free text, Raiffeisen `:NS:` blocks, German `?NN` subfields, SWIFT `{1:}{2:}{4:`
  envelopes; UTF-8 or Windows-1252 detected.
- Lines it cannot read are listed with their line number; the rest of the file still shows.
- **MT940: Open as Text** / **Open as Statement** in the editor title switch views; the text
  view has syntax colouring.

Nothing leaves your machine: the file is read locally, there is no network access and no
telemetry. See [SECURITY.md](SECURITY.md).

## Install

Download the `.vsix` from the [latest release](https://github.com/BlackSquirrelz/vscode-mt940-reader/releases/latest), then

```sh
code --install-extension mt940-reader-v0.1.0.vsix
```

or in VS Code: Extensions → `…` → **Install from VSIX…**

## Develop

```sh
npm install
npm test          # parser tests against samples/
npm run package   # → mt940-reader.vsix
```

The files in `samples/` are made up. Please never commit a real statement, not even in an issue.

Licensed under the [MIT License](LICENSE).
