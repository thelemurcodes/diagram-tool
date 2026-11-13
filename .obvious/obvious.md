# Repo Guidance — diagram-tool

## Railway production deployment approvals (standing rule from the owner, 2026-11-13)

You may approve a Railway production deployment yourself (through the API) only when ALL three hold:

- the service is a skeleton or pre-launch build on a `*.up.railway.app` domain;
- it handles no real money;
- it holds no real user data.

Anything on a real domain, or touching payments or real users' data (including captured leads or emails), is owner-only. In that case post `[<program>-approval]` on https://github.com/thelemurcodes/kit-booking/issues/21 with the deployment and what it changes, then wait. No reply is needed if nothing in this project is affected.
