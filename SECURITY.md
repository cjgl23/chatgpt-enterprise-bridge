# Security Policy

## Supported versions

Security fixes are targeted at the latest version on `main`.

## Reporting a vulnerability

Do not publicly post session cookies, API keys, browser profiles, prompt data, or exploit details.

Use **Security → Report a vulnerability** when private vulnerability reporting is available. Otherwise, open a public issue without sensitive details to arrange private contact.

## Deployment security notes

This bridge automates a real authenticated ChatGPT session. Run it only on `127.0.0.1` and never expose it through public reverse proxies or tunnels. Keep the saved browser profile and `chatgpt-session.json` private to your operating-system account. Store `CHATGPT_BRIDGE_API_KEY` securely, and avoid putting prompts and replies in logs. Revoke the session if you suspect access to its saved cookies.

Review dependency-update PRs and run the existing CI and Trivy checks before merging.
