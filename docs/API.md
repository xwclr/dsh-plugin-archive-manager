# `/archive-manager/api` — host/browser contract

The browser half and the host half of this plugin talk over three JSON methods
mounted by `lib/archive.cjs` on the host's own HTTP surface. This file is the
contract both halves implement; change it first when a shape changes.

## Transport

Every call is `POST <origin>/archive-manager/api/<method>` with
`content-type: application/json` and a JSON object body (never a bare value).

The response is always HTTP 200 with one envelope:

```json
{ "ok": true, "value": { } }
```

```json
{ "ok": false, "error": { "code": "failed", "message": "..." } }
```

A refusal is data, not a transport error: the page renders `error.message` next
to the action that caused it. Requests are fenced exactly like the skill-manager
route: loopback or a configured trusted host, no `sec-fetch-site: cross-site`,
and `origin` (when present) must name the same host.

## `list`

Request body: `{}`.

```json
{
  "home": "/Users/me/.dsh",
  "total": 14,
  "bytes": 48123,
  "projects": [
    {
      "id": "1045ebd5-9449-4d86-be51-bdead240ec1b",
      "title": "other",
      "path": "/Users/me/AIWORK/other",
      "total": 3,
      "bytes": 12000,
      "sessions": [
        {
          "id": "session-f13f3427-229e-416f-a474-9d589099e925",
          "title": "归档管理插件开发",
          "cwd": "/Users/me/AIWORK/other",
          "createdAt": 1791983283684,
          "archivedAt": 1791999999999,
          "bytes": 4000,
          "directory": "/Users/me/.dsh/sessions/--Users-me-AIWORK-other--/session-f13f3427-...",
          "exists": true,
          "live": false
        }
      ]
    }
  ],
  "ungrouped": { "total": 0, "bytes": 0, "sessions": [] }
}
```

Field rules:

- `projects` is ordered by the Host's workspace registry order. Only projects
  that currently own at least one archived session are listed.
- `ungrouped` holds archived sessions whose `cwd` matches no registered
  workspace (and archived ids whose session log is gone). `cwd` wins over the
  registry accounting when the two disagree; a session with no `cwd` falls back
  to the workspace that still accounts for it.
- `title` is `""` when the session log has no title; the page localizes an
  empty title.
- `archivedAt` is the session directory's mtime in epoch milliseconds; `0` when
  the discovery could not stat it. It is a *proxy* for the archive moment — DSH
  records no archive timestamp — and the page labels it as "last activity".
- `bytes` is the size of the session log file; `0` when unknown.
- `exists` is `false` for an archived id whose log is no longer on disk; such a
  row can still be restored (unarchiving only drops the id) but not deleted for
  space.
- `live` is `true` when a live Agent still owns the session. Archiving hides a
  session from the workspace surfaces but does not close the window that has it
  open, so an archived session is routinely live. `live` is a **display** fact
  only: the page labels it 已打开 / Open, and `delete` proceeds anyway (deleting
  an open session invalidates that window until it reloads). Only a *running*
  turn refuses the delete.
- `running` is `true` only while a turn is actually executing for that session.
  It comes from `sessionController.list()`'s `SessionSummary.running` — the
  authoritative live-control fact — not from `live`, so an open-but-idle
  session reads 已打开 rather than 运行中. Both flags fall back to `false` when
  that service is absent or its call fails.
- `total`/`bytes` are the sums of `projects[].total`/`bytes` plus
  `ungrouped`.

## `restore`

Request body:

```json
{ "sessionId": "session-<uuid>" }
```

Value: `{ "restored": ["session-<uuid>"] }`. Dropping the id from the archive
set is the whole operation; the session returns to its recorded position in its
workspace.

## `delete`

Request body:

```json
{ "sessionIds": ["session-<uuid>", "..."] }
```

Value:

```json
{
  "deleted": ["session-<uuid>"],
  "bytes": 12000,
  "failed": [
    { "sessionId": "session-<uuid>", "code": "live", "message": "a live agent owns this session" }
  ]
}
```

Delete is destructive and has no undo: it detaches the session from its
workspace, unarchives it, then removes the session directory and the projection
cache record. An open (live) session is deletable — the window that still has it
loses the session until it reloads. A session whose turn is **running**, that is
not archived, or whose id does not match the `session-<uuid>` grammar is refused
per-item rather than aborting the batch.

Each `failed[]` entry carries a stable `code` beside the human message so the
page can localize the refusal instead of printing Host English:

| `code` | Meaning |
| --- | --- |
| `running` | a turn is executing for the session (stop it, then delete) |
| `live` | a live Agent owns the session and the running flag was unavailable, so the delete refused conservatively |
| `not-archived` | the session is not in the archive set (already restored or deleted) |
| `malformed` | the id does not match `session-<uuid>` |
| `unsafe` | the on-disk target failed a containment/symlink/reality check |
| `failed` | any other per-item failure; `message` is the reason |
