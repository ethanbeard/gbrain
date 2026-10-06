# Exit codes

Every `gbrain` command exits with one of these statuses. An agent branches on
the exit code first, then reads the JSON document (`--json`) for the details:
`code`, `class`, `retryable` and `fix`. The protocol page is
[AGENT_OPERATOR_v1](../protocol/AGENT_OPERATOR_v1.md); error codes are listed in
[error codes](error-codes.md).

**Say to your agent:** *"The gbrain command exited 3. What does it need from me?"*

| Exit | Meaning | `--json` document | What the agent does |
|---|---|---|---|
| 0 | ok | the result | continue |
| 1 | failed | error envelope with `class` and `retryable` | follow `fix.next`; retry only when `retryable` is true |
| 2 | usage error or invalid input | error envelope (`invalid_params`, `unknown_flag`) | correct the command; `gbrain <command> --help` |
| 3 | `confirmation_required`: nothing ran | consent payload (`effects`, `user_message`, `fix`) | stop, relay `user_message` to the user, run `fix.command` only after they agree |
| 10 | the write was accepted and is still pending | write receipt | poll the receipt (`gbrain write-request -- <id>`); `--accept-pending` maps this to 0 |
| 11 | partial, resumable budget stop | result with `remaining_*` and `resume_command` | run `resume_command` (it is safe to re-run) |
| 75 | another runner holds the migration lock, or an engine graduation owns the brain (`graduation_in_progress`) | error envelope | wait for the other runner, then retry |
| 124 | the command's own deadline elapsed | error envelope | inspect what is still running (the message names the status command) |
| 130 | interrupted (SIGINT) | error envelope | ask the user whether to re-run |

`class` and `retryable` live only in the JSON document; the exit code stays
coarse so shell scripts can branch on it.

Under contract v1, `gbrain mcp expose` and `gbrain google` exit 2 when they
need the user's confirmation (documented legacy; changing it is a v2 item).

The per-command exit changes that came with contract v1 (v0.60.46.0) are in
the [CHANGELOG](../../CHANGELOG.md#exit-code-changes-by-command).
