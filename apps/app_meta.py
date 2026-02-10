from __future__ import annotations

import os


APP_NAME = "V2X Scene Explorer"
APP_VERSION = str(os.environ.get("TRAJ_APP_VERSION") or "0.2.0").strip() or "0.2.0"

# GitHub repo used by the in-app update checker.
# Format: "owner/repo"
DEFAULT_UPDATE_REPO = str(os.environ.get("TRAJ_UPDATE_REPO") or "H-shayea/V2X-Scene-Explorer").strip()

