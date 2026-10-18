# ระบบโหวตเลือกแบบเสื้อที่ระลึก 88 ปี

Voting page for the Roi Et Vocational College 88th-anniversary shirt. Staff pick their name, vote for a design, and give the cut and size of each shirt they order (the first is free, extras are paid). Votes from every device are saved on the server.

Live at https://rvc88.tuatorton.com

## Run locally

Needs Node 18 or newer. There are no packages to install. `data/staff.json` is not in this repo (it holds staff names); put it in place first.

```bash
ADMIN_KEY=your-password node server.js
```

Then open http://localhost:3000.

## Deploy (server behind Traefik)

The project lives at `/opt/data/projects/rvc88` on the server. `.env` there holds `ADMIN_KEY=...`, and `data/staff.json` is copied in by hand.

```bash
cd /opt/data/projects/rvc88 && git pull && docker compose up -d --build
```

Votes and the results switch are kept in the `rvc88_store` Docker volume, so rebuilds keep them.

## Settings (environment variables)

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Folder that holds `votes.json` and `settings.json` |
| `ADMIN_KEY` | (none) | Password for the results page, the Excel/CSV downloads and clearing all votes. Without it those are turned off. |
| `VOTING_OPEN` | `true` | `false` closes voting |
| `ALLOW_CHANGE_VOTE` | `true` | `false` stops people from editing a vote |
| `HIDE_RESULTS` | `false` | `true` hides results per design |
| `SAMPLE_DATA` | `false` | `true` shows generated sample votes on the results page |

## Data

- `data/staff.json`: the staff list, `[["name", "department"], ...]`. Only names on this list can vote. The server reads it at start, so restart after editing it.
- `votes.json` and `settings.json` in `DATA_DIR`: written by the server. Back them up before clearing votes.

Phone numbers and notes only go to the admin. When results are opened to everyone, the public view leaves them out.
