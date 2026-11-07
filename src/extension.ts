import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from './parser';
import { render, styles } from './render';

/**
 * Opens .mt940, .sta and .940 files as statements, and keeps the text one step away: the
 * editor title has a button each way, and every entry links to its line in the file.
 */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('mt940.statement', new StatementEditor(), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('mt940.openAsText', (uri?: vscode.Uri) => openAsText(uri ?? activeUri())),
    vscode.commands.registerCommand('mt940.openAsStatement', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) {
        return vscode.commands.executeCommand('vscode.openWith', target, 'mt940.statement');
      }
    }),
  );
}

export function deactivate() {}

function activeUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined;
}

async function openAsText(uri: vscode.Uri | undefined, line?: number) {
  if (!uri) {
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
  const editor = vscode.window.activeTextEditor;
  if (editor && line) {
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, editor.document.lineAt(line - 1).range.end);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

/**
 * The file's bytes as text. UTF-8 when they are valid UTF-8; otherwise Windows-1252, which is
 * what Swiss banks' exports are in (Raiffeisen's are) — read as UTF-8 an "Ü" becomes "�".
 */
function decode(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

class StatementEditor implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };

    const show = async () => {
      try {
        const { text, encoding } = decode(await vscode.workspace.fs.readFile(document.uri));
        panel.webview.html = page(render(parse(text), path.basename(document.uri.fsPath), encoding));
      } catch (e) {
        panel.webview.html = page(`<p class="bad">Could not read the file: ${(e as Error).message}</p>`);
      }
    };

    // Re-read when the file changes on disk, or is saved from the text editor beside it.
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, path.basename(document.uri.fsPath)));
    const saved = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() === document.uri.toString()) {
        void show();
      }
    });
    watcher.onDidChange(() => void show());
    panel.onDidDispose(() => {
      watcher.dispose();
      saved.dispose();
    });

    panel.webview.onDidReceiveMessage((message: { type: string; line: number }) => {
      if (message.type === 'goto') {
        void openAsText(document.uri, message.line);
      }
    });

    await show();
  }
}

function page(body: string): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${styles}</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a.goto');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'goto', line: Number(link.dataset.line) });
      return;
    }
    const row = e.target.closest('tr.main');
    if (row) {
      const more = document.getElementById(row.dataset.target);
      more.hidden = !more.hidden;
    }
  });
  const filter = document.getElementById('filter');
  if (filter) {
    filter.addEventListener('input', () => {
      const words = filter.value.toLowerCase().split(/\\s+/).filter(Boolean);
      for (const entry of document.querySelectorAll('tbody.entry')) {
        entry.hidden = !words.every((w) => entry.dataset.search.includes(w));
      }
    });
  }
</script>
</body>
</html>`;
}
