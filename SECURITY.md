# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | ✅        |
| < 0.4   | ❌        |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email the maintainer directly at the address on the npm package page. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof-of-concept
- The version(s) affected

You will receive an acknowledgement within 48 hours and a resolution timeline
within 7 days. Vulnerabilities that affect the public API or allow code
execution or data leakage will be patched and disclosed with a CVE where
appropriate.

## Security design notes

**`calculatorTool` does not use `eval()`.** Expressions are evaluated by a
hand-written recursive-descent parser with an explicit allowlist of functions
(`abs`, `sqrt`, `floor`, etc.) and constants (`pi`, `e`). Arbitrary code
execution via the calculator is not possible.

**`fileReaderTool` sandboxes the working directory.** Absolute paths and
directory traversal (`../`) are rejected before any file system access.
`path.isAbsolute()` catches Unix, Windows drive-letter, and Windows UNC paths.

**`fetchTool` makes arbitrary HTTP requests by design.** This is an intentional
capability, not a vulnerability. Callers are responsible for ensuring the agent
only has access to tools appropriate for their trust model. Do not register
`fetchTool` in environments where the agent prompt is controlled by untrusted
input without additional validation.

**Cache keys use SHA-256, not a faster hash.** Non-cryptographic hashes (djb2,
FNV) can cluster on structured JSON inputs. SHA-256's avalanche property
prevents this class of collision. Cache entries are stored in-process only -
there is no network exposure by default.

**Run IDs use `crypto.randomBytes(8)`.**  8 random bytes from the OS CSPRNG, hex-encoded to 16 characters. Birthday-bound collision probability for 10⁶ runs in a 2⁶⁴ space is ~2.7×10⁻⁸ - negligible for any practical deployment and appropriate for use as a correlation key in logs and distributed traces.
