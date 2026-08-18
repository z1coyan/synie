#!/usr/bin/env python3
"""jdyChinaDate 单测。python3 scripts/jdy-replay/china_date_test.py"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from china_date import jdyChinaDate  # noqa: E402


def test_t16_zulu_is_china_next_midnight() -> None:
    assert jdyChinaDate("2019-12-31T16:00:00.000Z") == "2020-01-01"
    assert jdyChinaDate("2019-12-31T16:00:00Z") == "2020-01-01"
    assert jdyChinaDate("2020-08-17T16:00:00.000Z") == "2020-08-18"
    assert jdyChinaDate("2025-07-02T16:00:00.000Z") == "2025-07-03"


def test_other_aware_uses_cst_calendar() -> None:
    assert jdyChinaDate("2020-01-01T00:00:00+08:00") == "2020-01-01"
    assert jdyChinaDate("2020-01-01T00:00:00Z") == "2020-01-01"
    assert jdyChinaDate("2020-01-01T20:00:00.000Z") == "2020-01-02"
    assert jdyChinaDate("2019-12-31T16:00:00+00:00") == "2020-01-01"
    # 已是中国次日 0 点
    assert jdyChinaDate("2020-01-01T00:00:00.000+08:00") == "2020-01-01"


def test_naive_iso_treated_as_utc() -> None:
    """T without offset/Z is UTC, not host local. Same under UTC / CST / US TZ."""
    prev = os.environ.get("TZ")
    try:
        for tz in ("UTC", "Asia/Shanghai", "America/New_York"):
            os.environ["TZ"] = tz
            time.tzset()
            assert jdyChinaDate("2020-01-01T20:00:00") == "2020-01-02", tz
            assert jdyChinaDate("2019-12-31T16:00:00") == "2020-01-01", tz
            assert jdyChinaDate("2020-01-01T20:00:00") == jdyChinaDate(
                "2020-01-01T20:00:00Z"
            )
    finally:
        if prev is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = prev
        time.tzset()


def test_already_ymd_unchanged() -> None:
    assert jdyChinaDate("2020-01-01") == "2020-01-01"
    assert jdyChinaDate("2019-12-31") == "2019-12-31"
    assert jdyChinaDate("2026-08-17") == "2026-08-17"


def test_empty_is_none() -> None:
    assert jdyChinaDate(None) is None
    assert jdyChinaDate("") is None
    assert jdyChinaDate("   ") is None


def test_invalid_with_t_raises() -> None:
    try:
        jdyChinaDate("not-a-datetimeTfoo")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_matches_iso_cn_semantics() -> None:
    """与 fix_bills_holdings_discount.iso_cn 同一语义。"""
    cases = [
        (None, None),
        ("", None),
        ("2020-01-01", "2020-01-01"),
        ("2019-12-31T16:00:00.000Z", "2020-01-01"),
        ("2019-12-31T16:00:00Z", "2020-01-01"),
        ("2020-01-01T00:00:00+08:00", "2020-01-01"),
    ]
    for raw, want in cases:
        assert jdyChinaDate(raw) == want, raw


if __name__ == "__main__":
    test_t16_zulu_is_china_next_midnight()
    test_other_aware_uses_cst_calendar()
    test_naive_iso_treated_as_utc()
    test_already_ymd_unchanged()
    test_empty_is_none()
    test_invalid_with_t_raises()
    test_matches_iso_cn_semantics()
    print("ok")
