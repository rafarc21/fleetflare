# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's private
vulnerability reporting:

https://github.com/rafarc21/fleetflare/security/advisories/new

Do not open a public issue, pull request or discussion for a suspected
vulnerability. Include what you found, how to reproduce it, and what an
attacker could do with it. You will get an acknowledgement, and a fix or a
decision, through the advisory thread.

## Scope

Fleetflare runs coding agents as root inside cloud containers that hold
real credentials. Read [docs/threat-model.md](docs/threat-model.md) before
deploying it: it lists what a studio container can reach, which tokens it
holds, and which risks are accepted by design rather than bugs.

In scope:

- the Worker (`apps/fleet/src`): authentication of its HTTP routes, webhook
  verification, and anything that lets a caller act on a studio or a
  repository they should not reach;
- credential handling: a token reaching a place the threat model says it
  never goes (for example, a Cloudflare deploy credential inside a studio);
- the CLI (`apps/fleet/cli`): local credential storage and anything it sends;
- the gates (`gates/`), where a bypass lets a studio merge, deploy or mark
  work complete without the checks the gate exists to enforce.

Out of scope: behavior the threat model documents as accepted, such as a
studio's agent having root in its own container, or the agent reading the
credentials that container was given.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches.
