# Security

Bank statements are sensitive. The extension reads the file you open, locally, and sends
nothing anywhere: no network access, no telemetry, no runtime dependencies. The statement is
rendered in a webview with a strict content security policy and every value from the file is
HTML-escaped.

Please report a vulnerability privately through GitHub's **Report a vulnerability** (Security
tab → Advisories), not as a public issue. Never attach a real statement; a made-up file that
shows the problem is enough.
