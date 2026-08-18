"""简道云日期 → 中国日历日。

简道云日期控件几乎全是 T16:00:00.000Z（= 中国次日 0 点）。截 UTC 前 10 位会早一天。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))


def jdyChinaDate(iso) -> str | None:
    """T16:00:00.000Z → UTC+8 日历日；其它带时区按 CST；已是 YYYY-MM-DD 不动。"""
    if iso is None:
        return None
    s = str(iso).strip()
    if not s:
        return None
    if "T" not in s:
        return s[:10]
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt.astimezone(CST).date().isoformat()
