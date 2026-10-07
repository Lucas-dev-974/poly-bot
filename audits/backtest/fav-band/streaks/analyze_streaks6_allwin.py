# -*- coding: utf-8 -*-
"""Follow-up: streaks of exactly/≥6 wins + all-win créneaux/jours (Paris TZ).
Read-only on series-sim-15m.csv (already extracted). Writes md+json under streaks/.
"""
from __future__ import annotations
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
d = pd.read_csv(HERE / "series-sim-15m.csv")
d["t"] = pd.to_datetime(d["entryParis"])
d["date"] = d["t"].dt.date.astype(str)
d["h1"] = d["hour"].astype(int)
n_total = len(d)
base_wr = float(d["win"].mean())
WD = {0: "Lun", 1: "Mar", 2: "Mer", 3: "Jeu", 4: "Ven", 5: "Sam", 6: "Dim"}
# weekday already as French abbr in CSV; also recompute from date for safety
d["wd_name"] = d["weekday"]

# ---- 1. Streaks ≥6 and exactly 6 ----
streaks = []
i = 0
while i < len(d):
    if d.iloc[i]["win"] == 1 and d.iloc[i]["posInRun"] == 1:
        L = int(d.iloc[i]["runLen"])
        if L >= 6:
            seg = d.iloc[i : i + L]
            hours = sorted(set(int(h) for h in seg["h1"].tolist()))
            streaks.append(
                dict(
                    len=L,
                    start=str(seg["entryParis"].iloc[0])[:16],
                    end=str(seg["entryParis"].iloc[-1])[:16],
                    date_start=seg["date"].iloc[0],
                    date_end=seg["date"].iloc[-1],
                    weekday=str(seg["wd_name"].iloc[0]),
                    startHour=int(seg["h1"].iloc[0]),
                    endHour=int(seg["h1"].iloc[-1]),
                    hoursCovered=hours,
                    n_trades=L,
                    wins=int(seg["win"].sum()),
                    pnl=round(float(seg["pnl"].sum()), 2),
                    crossesMidnight=bool(seg["date"].iloc[0] != seg["date"].iloc[-1]),
                )
            )
        i += L
    else:
        i += 1

streaks_ge6 = streaks
streaks_eq6 = [s for s in streaks if s["len"] == 6]
streaks_gt6 = [s for s in streaks if s["len"] > 6]

# length distribution for ≥6
from collections import Counter
len_dist = dict(sorted(Counter(s["len"] for s in streaks_ge6).items()))

# ---- 2. Bins: hour, 2h, 3h, calendar day — flag 100% and near-perfect ----
def summarize_group(g: pd.DataFrame, label: str, kind: str) -> dict:
    n = len(g)
    w = int(g["win"].sum())
    wr = round(100.0 * w / n, 1) if n else None
    pnl = round(float(g["pnl"].sum()), 2)
    days = sorted(g["date"].unique().tolist())
    return dict(
        bin=label,
        kind=kind,
        n=n,
        wins=w,
        losses=n - w,
        wr=wr,
        pnl=pnl,
        distinctDays=len(days),
        days=days,
        allWins=bool(n >= 1 and w == n),
        nearPerfect=bool(n >= 5 and wr is not None and wr >= 90.0),
        flag100=bool(n >= 1 and w == n),
    )


by_hour = []
for h in range(24):
    g = d[d["h1"] == h]
    if len(g) == 0:
        continue
    by_hour.append(summarize_group(g, f"{h:02d}h-{(h+1)%24:02d}h", "1h"))

by_2h = []
for h in range(0, 24, 2):
    g = d[d["h1"].isin([h, (h + 1) % 24])]
    if len(g) == 0:
        continue
    by_2h.append(summarize_group(g, f"{h:02d}h-{(h+2)%24:02d}h", "2h"))

by_3h_aligned = []
for h in range(0, 24, 3):
    hrs = [(h + i) % 24 for i in range(3)]
    g = d[d["h1"].isin(hrs)]
    if len(g) == 0:
        continue
    by_3h_aligned.append(summarize_group(g, f"{h:02d}h-{(h+3)%24:02d}h", "3h-aligned"))

by_3h_rolling = []
for h in range(24):
    hrs = [(h + i) % 24 for i in range(3)]
    g = d[d["h1"].isin(hrs)]
    if len(g) == 0:
        continue
    by_3h_rolling.append(summarize_group(g, f"{h:02d}h-{(h+3)%24:02d}h", "3h-rolling"))

# also 4h rolling for créneau exploration
by_4h_rolling = []
for h in range(24):
    hrs = [(h + i) % 24 for i in range(4)]
    g = d[d["h1"].isin(hrs)]
    if len(g) == 0:
        continue
    by_4h_rolling.append(summarize_group(g, f"{h:02d}h-{(h+4)%24:02d}h", "4h-rolling"))

by_day = []
for date, g in d.groupby("date", sort=True):
    wd = g["wd_name"].iloc[0]
    row = summarize_group(g, str(date), "calendar-day")
    row["weekday"] = wd
    by_day.append(row)

# per-day × hour (créneau journalier) — for finding 100% day-slots
by_day_hour = []
for (date, h), g in d.groupby(["date", "h1"], sort=True):
    wd = g["wd_name"].iloc[0]
    row = summarize_group(g, f"{date} {int(h):02d}h", "day-hour")
    row["date"] = date
    row["hour"] = int(h)
    row["weekday"] = wd
    by_day_hour.append(row)

# multi-hour contiguous within a single calendar day (créneau du jour)
# for each day, find maximal contiguous hour-runs that are 100% wins with n>=2
# also report all day×2h and day×3h bins that are 100%
by_day_2h = []
by_day_3h = []
for date, gd in d.groupby("date", sort=True):
    wd = gd["wd_name"].iloc[0]
    for h in range(0, 24, 2):
        g = gd[gd["h1"].isin([h, h + 1])]
        if len(g) == 0:
            continue
        row = summarize_group(g, f"{date} {h:02d}h-{(h+2)%24:02d}h", "day-2h")
        row["date"] = date
        row["startHour"] = h
        row["weekday"] = wd
        by_day_2h.append(row)
    for h in range(0, 24, 3):
        g = gd[gd["h1"].isin([h, h + 1, h + 2])]
        if len(g) == 0:
            continue
        row = summarize_group(g, f"{date} {h:02d}h-{(h+3)%24:02d}h", "day-3h")
        row["date"] = date
        row["startHour"] = h
        row["weekday"] = wd
        by_day_3h.append(row)

# Flag sets
def pick_all_win(rows, min_n=1):
    return [r for r in rows if r["allWins"] and r["n"] >= min_n]

def pick_near(rows, min_n=5, min_wr=90.0):
    return [r for r in rows if r["n"] >= min_n and r["wr"] is not None and r["wr"] >= min_wr]

all_win_hours = pick_all_win(by_hour, min_n=1)  # none expected at aggregate hour level
all_win_hours_n5 = pick_all_win(by_hour, min_n=5)
near_hours = pick_near(by_hour)
all_win_2h = pick_all_win(by_2h, min_n=5)
near_2h = pick_near(by_2h)
all_win_3h = pick_all_win(by_3h_aligned, min_n=5)
near_3h = pick_near(by_3h_aligned)
all_win_3h_roll = pick_all_win(by_3h_rolling, min_n=5)
near_3h_roll = pick_near(by_3h_rolling)
all_win_days = pick_all_win(by_day, min_n=1)
near_days = pick_near(by_day)

# day-hour with n>=2 all wins (créneau journalier)
all_win_day_hour = pick_all_win(by_day_hour, min_n=2)
all_win_day_hour_n3 = pick_all_win(by_day_hour, min_n=3)
all_win_day_2h = pick_all_win(by_day_2h, min_n=3)
all_win_day_3h = pick_all_win(by_day_3h, min_n=3)
near_day_2h = pick_near(by_day_2h)
near_day_3h = pick_near(by_day_3h)

# ---- 3. Do 6-win streaks recur in same créneau across days? ----
# For each streak ≥6 (incl exact 6), map startHour and hoursCovered.
# Recurrence: same startHour on ≥2 different date_start, or overlapping hour-set across days.
by_start_hour = defaultdict(list)
for s in streaks_ge6:
    by_start_hour[s["startHour"]].append(s)

recurrence_by_start = []
for h, lst in sorted(by_start_hour.items()):
    dates = sorted(set(s["date_start"] for s in lst))
    # also count exact-6 only
    eq6 = [s for s in lst if s["len"] == 6]
    recurrence_by_start.append(
        dict(
            startHour=h,
            n_streaks_ge6=len(lst),
            n_streaks_eq6=len(eq6),
            distinctDays=len(dates),
            dates=dates,
            lengths=[s["len"] for s in lst],
            starts=[s["start"] for s in lst],
            recurs=len(dates) >= 2,
        )
    )

# Hour membership: for each clock hour, how many ≥6 streaks cover it, on how many days
hour_coverage = []
for h in range(24):
    covering = [s for s in streaks_ge6 if h in s["hoursCovered"]]
    dates = sorted(set(s["date_start"] for s in covering) | set(s["date_end"] for s in covering if h in s["hoursCovered"]))
    # better: dates where that hour had a trade that was inside a ≥6 streak
    in_streak = d[(d["h1"] == h) & (d["win"] == 1) & (d["runLen"] >= 6)]
    days_with = sorted(in_streak["date"].unique().tolist())
    hour_coverage.append(
        dict(
            hour=h,
            n_streaks_covering=len(covering),
            distinctDaysWithTradeInGe6Streak=len(days_with),
            days=days_with,
            n_trades_in_ge6=int(len(in_streak)),
            recurs=len(days_with) >= 2,
        )
    )

# Exact-6 start-hour recurrence specifically
eq6_by_start = defaultdict(list)
for s in streaks_eq6:
    eq6_by_start[s["startHour"]].append(s)
eq6_recurrence = []
for h, lst in sorted(eq6_by_start.items()):
    dates = sorted(set(s["date_start"] for s in lst))
    eq6_recurrence.append(
        dict(
            startHour=h,
            n=len(lst),
            distinctDays=len(dates),
            dates=dates,
            starts=[s["start"] for s in lst],
            recurs=len(dates) >= 2,
        )
    )

# Overlap of hoursCovered between eq6 streaks on different days
# For each pair of eq6 on different days, Jaccard of hoursCovered
eq6_pair_overlap = []
for i, a in enumerate(streaks_eq6):
    for b in streaks_eq6[i + 1 :]:
        if a["date_start"] == b["date_start"]:
            continue
        sa, sb = set(a["hoursCovered"]), set(b["hoursCovered"])
        inter = sa & sb
        union = sa | sb
        eq6_pair_overlap.append(
            dict(
                a=a["start"],
                b=b["start"],
                hoursA=a["hoursCovered"],
                hoursB=b["hoursCovered"],
                intersection=sorted(inter),
                jaccard=round(len(inter) / len(union), 2) if union else 0,
                sameStartHour=a["startHour"] == b["startHour"],
            )
        )
# keep only pairs with any overlap
eq6_pair_overlap_hit = [p for p in eq6_pair_overlap if p["intersection"]]
eq6_pair_overlap_hit.sort(key=lambda p: (-len(p["intersection"]), -p["jaccard"]))

# ---- Assemble output ----
out = dict(
    meta=dict(
        source="series-sim-15m.csv (sim_positions fav-band btc-updown-15m FOK marketable)",
        n=n_total,
        baselineWR=round(100 * base_wr, 1),
        tz="Europe/Paris (CEST UTC+2)",
        winDef="pnl > 0",
        generated="2026-10-05",
        focus="streaks length ≥6 / exactly 6; 100% WR créneaux & calendar days",
    ),
    streaks=dict(
        count_ge6=len(streaks_ge6),
        count_eq6=len(streaks_eq6),
        count_gt6=len(streaks_gt6),
        lengthDistribution_ge6=len_dist,
        all_ge6=streaks_ge6,
        exactly6=streaks_eq6,
    ),
    allWinSlots=dict(
        note="allWins = every trade in bin is a win. Aggregate hour/2h/3h rarely hit 100% given n~17-40. Day-level and day×hour are the practical flags.",
        hours_100_any_n=all_win_hours,
        hours_100_n_ge5=all_win_hours_n5,
        hours_nearPerfect_wr_ge90_n_ge5=near_hours,
        bins2h_100_n_ge5=all_win_2h,
        bins2h_near=near_2h,
        bins3h_aligned_100_n_ge5=all_win_3h,
        bins3h_aligned_near=near_3h,
        bins3h_rolling_100_n_ge5=all_win_3h_roll,
        bins3h_rolling_near=near_3h_roll,
        calendarDays_100=all_win_days,
        calendarDays_near=near_days,
        dayHour_100_n_ge2=all_win_day_hour,
        dayHour_100_n_ge3=all_win_day_hour_n3,
        day2h_100_n_ge3=all_win_day_2h,
        day3h_100_n_ge3=all_win_day_3h,
        day2h_near=near_day_2h,
        day3h_near=near_day_3h,
    ),
    tables=dict(
        byHour=by_hour,
        by2h=by_2h,
        by3h_aligned=by_3h_aligned,
        by3h_rolling=by_3h_rolling,
        by4h_rolling=by_4h_rolling,
        byDay=by_day,
    ),
    recurrence6=dict(
        byStartHour_ge6=recurrence_by_start,
        byStartHour_eq6=eq6_recurrence,
        hourCoverage_ge6=hour_coverage,
        eq6_crossDay_hourOverlap=eq6_pair_overlap_hit[:30],
        summary=dict(
            startHours_with_ge6_on_multiple_days=[r for r in recurrence_by_start if r["recurs"]],
            startHours_with_eq6_on_multiple_days=[r for r in eq6_recurrence if r["recurs"]],
            hours_covered_by_ge6_on_multiple_days=[r for r in hour_coverage if r["recurs"]],
        ),
    ),
)

json_path = HERE / "streaks-6-and-allwin-slots-2026-10-05.json"
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

# ---- Markdown report ----
def fmt_streak_table(rows):
    lines = ["| Long. | Début (Paris) | Fin (Paris) | Jour | Heures | PnL |",
             "|------:|:--------------|:------------|:-----|:-------|----:|"]
    for s in rows:
        hrs = ",".join(f"{h:02d}" for h in s["hoursCovered"])
        lines.append(
            f"| {s['len']} | {s['start']} | {s['end']} | {s['weekday']} | {hrs} | {s['pnl']:+.2f} |"
        )
    return "\n".join(lines)

def fmt_bin_table(rows, extra_cols=None):
    # bin, n, wins, wr, pnl, days, flags
    lines = ["| Bin | n | W | WR | PnL | Jours | Flags |",
             "|:----|--:|--:|---:|----:|------:|:------|"]
    for r in sorted(rows, key=lambda x: (-(x["wr"] or 0), -x["n"])):
        flags = []
        if r.get("allWins"):
            flags.append("100%")
        if r.get("nearPerfect"):
            flags.append("≥90% n≥5")
        fl = ", ".join(flags) if flags else "—"
        lines.append(
            f"| {r['bin']} | {r['n']} | {r['wins']} | {r['wr']}% | {r['pnl']:+.2f} | {r['distinctDays']} | {fl} |"
        )
    return "\n".join(lines)

md = []
md.append("# Fav-band — streaks de 6 wins & créneaux/jours 100% WR — 2026-10-05")
md.append("")
md.append("Suite du rapport `RAPPORT-streaks-fenetres-fav-band-2026-10-05.md`.")
md.append("Toutes les heures en **heure de Paris (CEST, UTC+2)**. Lecture seule sur la série sim déjà extraite.")
md.append("")
md.append("## Source")
md.append("")
md.append(f"- Primaire : `sim_positions` fav-band, `btc-updown-15m`, FOK marketable — **n = {n_total}**, WR baseline **{100*base_wr:.1f}%**.")
md.append("- Série : `series-sim-15m.csv` (W = `pnl > 0`, horodatage = entrée `createdAt` → Paris).")
md.append("- Une streak = run maximal de W consécutifs (même définition que le rapport parent ; trous de sim ne coupent pas).")
md.append("")
md.append("## 1. Streaks de longueur ≥ 6")
md.append("")
md.append(f"- **≥ 6** : **{len(streaks_ge6)}** streaks (dont **exactement 6** : **{len(streaks_eq6)}**, **> 6** : **{len(streaks_gt6)}**).")
md.append(f"- Distribution des longueurs (≥6) : {', '.join(f'{k}:{v}' for k,v in len_dist.items())}.")
md.append("")
md.append("### 1.1 Toutes les streaks ≥ 6")
md.append("")
md.append(fmt_streak_table(streaks_ge6))
md.append("")
md.append("### 1.2 Exactement 6 wins")
md.append("")
if streaks_eq6:
    md.append(fmt_streak_table(streaks_eq6))
else:
    md.append("_Aucune._")
md.append("")

# Recurrence section
md.append("## 2. Récurrence des streaks ≥6 / =6 dans le même créneau")
md.append("")
rec_ge6 = [r for r in recurrence_by_start if r["recurs"]]
rec_eq6 = [r for r in eq6_recurrence if r["recurs"]]
md.append("### 2.1 Même heure de **début** sur ≥ 2 jours")
md.append("")
if rec_ge6:
    md.append("| Heure début | n streaks ≥6 | n =6 | Jours distincts | Dates | Longueurs |")
    md.append("|------------:|-------------:|-----:|----------------:|:------|:----------|")
    for r in rec_ge6:
        md.append(
            f"| {r['startHour']:02d}h | {r['n_streaks_ge6']} | {r['n_streaks_eq6']} | {r['distinctDays']} | {', '.join(r['dates'])} | {r['lengths']} |"
        )
else:
    md.append("_Aucune heure de début ne porte une streak ≥6 sur plus d'un jour._")
md.append("")
if rec_eq6:
    md.append("Exactement 6 — heures de début récurrentes :")
    md.append("")
    md.append("| Heure début | n =6 | Jours | Dates | Débuts |")
    md.append("|------------:|-----:|------:|:------|:-------|")
    for r in rec_eq6:
        md.append(
            f"| {r['startHour']:02d}h | {r['n']} | {r['distinctDays']} | {', '.join(r['dates'])} | {', '.join(r['starts'])} |"
        )
else:
    md.append("_Aucune heure de début ne porte **deux** streaks exactes de 6 sur des jours différents._")
md.append("")
md.append("### 2.2 Heures **couvertes** par ≥1 trade d'une streak ≥6, sur ≥ 2 jours")
md.append("")
cov_rec = [r for r in hour_coverage if r["recurs"]]
if cov_rec:
    md.append("| Heure | Jours avec trade dans streak ≥6 | n trades dans ≥6 | Jours |")
    md.append("|------:|--------------------------------:|-----------------:|:------|")
    for r in cov_rec:
        md.append(
            f"| {r['hour']:02d}h | {r['distinctDaysWithTradeInGe6Streak']} | {r['n_trades_in_ge6']} | {', '.join(r['days'])} |"
        )
else:
    md.append("_Aucune._")
md.append("")
md.append("### 2.3 Chevauchement d'heures entre streaks **exactement 6** sur jours différents")
md.append("")
if eq6_pair_overlap_hit:
    md.append("| Streak A | Streak B | Heures A | Heures B | Intersection | Jaccard | Même h début |")
    md.append("|:---------|:---------|:---------|:---------|:-------------|--------:|:-------------|")
    for p in eq6_pair_overlap_hit[:15]:
        md.append(
            f"| {p['a']} | {p['b']} | {p['hoursA']} | {p['hoursB']} | {p['intersection']} | {p['jaccard']} | {'oui' if p['sameStartHour'] else 'non'} |"
        )
else:
    md.append("_Aucun chevauchement d'heures entre deux streaks =6 de jours distincts._")
md.append("")

# All-win slots
md.append("## 3. Créneaux / jours à **100 % de wins** (et quasi-parfaits)")
md.append("")
md.append("Définitions : **100%** = tous les trades du bin sont des wins ; **quasi-parfait** = WR ≥ 90 % et n ≥ 5.")
md.append("Les bins agrégés (heure / 2h / 3h sur toute la période) ont n ≈ 17–40 : un 100% y est rare.")
md.append("Les créneaux **jour × heure** (et jour × 2h/3h) sont listés séparément — ce sont les « créneaux du jour » demandés.")
md.append("")

md.append("### 3.1 Heures agrégées (24 bins, toute la période)")
md.append("")
if near_hours:
    md.append(fmt_bin_table(near_hours))
else:
    md.append("_Aucun bin 1h avec WR ≥ 90 % et n ≥ 5._")
md.append("")
if all_win_hours_n5:
    md.append("**100% avec n ≥ 5 :**")
    md.append(fmt_bin_table(all_win_hours_n5))
else:
    md.append("**Aucun** bin 1h agrégé à 100 % avec n ≥ 5.")
md.append("")

md.append("### 3.2 Bins 2 h et 3 h agrégés — quasi-parfaits / 100%")
md.append("")
md.append("**2h — WR ≥ 90 %, n ≥ 5 :**")
md.append("")
if near_2h:
    md.append(fmt_bin_table(near_2h))
else:
    md.append("_Aucun._")
md.append("")
md.append("**3h alignés — WR ≥ 90 %, n ≥ 5 :**")
md.append("")
if near_3h:
    md.append(fmt_bin_table(near_3h))
else:
    md.append("_Aucun._")
md.append("")
md.append("**3h glissants — WR ≥ 90 %, n ≥ 5 :**")
md.append("")
if near_3h_roll:
    md.append(fmt_bin_table(near_3h_roll))
else:
    md.append("_Aucun._")
md.append("")
if not (all_win_2h or all_win_3h or all_win_3h_roll):
    md.append("**Aucun** bin 2h/3h agrégé à 100 % avec n ≥ 5.")
md.append("")

md.append("### 3.3 Jours calendaires")
md.append("")
md.append(fmt_bin_table(by_day))
md.append("")
if all_win_days:
    md.append(f"**Jours 100% :** {', '.join(r['bin'] for r in all_win_days)}.")
else:
    md.append("**Aucun jour calendaire à 100 % de wins** (max observé ci-dessus).")
md.append("")
if near_days:
    md.append("**Jours quasi-parfaits (WR >= 90 %, n >= 5) :** " + ", ".join("%s (%.1f%%, n=%d)" % (r["bin"], r["wr"], r["n"]) for r in near_days) + ".")
else:
    md.append("**Aucun jour** avec WR ≥ 90 % et n ≥ 5.")
md.append("")

md.append("### 3.4 Créneaux jour × heure (100 %, n ≥ 2 et n ≥ 3)")
md.append("")
md.append(f"Nombre de (jour, heure) à 100 % avec n ≥ 2 : **{len(all_win_day_hour)}** ; avec n ≥ 3 : **{len(all_win_day_hour_n3)}**.")
md.append("")
if all_win_day_hour_n3:
    md.append("**100 % et n ≥ 3** (créneaux journaliers les plus solides en taille) :")
    md.append("")
    md.append("| Date | Heure | Jour | n | PnL |")
    md.append("|:-----|------:|:-----|--:|----:|")
    for r in sorted(all_win_day_hour_n3, key=lambda x: (x["date"], x["hour"])):
        md.append(f"| {r['date']} | {r['hour']:02d}h | {r['weekday']} | {r['n']} | {r['pnl']:+.2f} |")
    md.append("")
if all_win_day_hour:
    # compress: list hours per day that are 100% n>=2
    byd = defaultdict(list)
    for r in all_win_day_hour:
        byd[r["date"]].append((r["hour"], r["n"], r["weekday"]))
    md.append("Résumé par jour — heures 100 % (n ≥ 2) :")
    md.append("")
    md.append("| Date | Jour | Heures 100% (n) |")
    md.append("|:-----|:-----|:----------------|")
    for date in sorted(byd):
        items = sorted(byd[date])
        wd = items[0][2]
        cells = ", ".join(f"{h:02d}h (n={n})" for h, n, _ in items)
        md.append(f"| {date} | {wd} | {cells} |")
    md.append("")

md.append("### 3.5 Créneaux jour × 2h / 3h à 100 % (n ≥ 3)")
md.append("")
if all_win_day_2h:
    md.append("**Jour × 2h, 100 %, n ≥ 3 :**")
    md.append("")
    md.append("| Bin | Jour | n | PnL |")
    md.append("|:----|:-----|--:|----:|")
    for r in sorted(all_win_day_2h, key=lambda x: (x["date"], x["startHour"])):
        md.append(f"| {r['bin']} | {r['weekday']} | {r['n']} | {r['pnl']:+.2f} |")
    md.append("")
else:
    md.append("_Aucun jour×2h à 100 % avec n ≥ 3._")
    md.append("")
if all_win_day_3h:
    md.append("**Jour × 3h, 100 %, n ≥ 3 :**")
    md.append("")
    md.append("| Bin | Jour | n | PnL |")
    md.append("|:----|:-----|--:|----:|")
    for r in sorted(all_win_day_3h, key=lambda x: (x["date"], x["startHour"])):
        md.append(f"| {r['bin']} | {r['weekday']} | {r['n']} | {r['pnl']:+.2f} |")
    md.append("")
else:
    md.append("_Aucun jour×3h à 100 % avec n ≥ 3._")
    md.append("")

# Which hours appear most often as 100% day-slots
md.append("### 3.6 Heures qui reviennent le plus souvent en 100 % (jour × heure, n ≥ 2)")
md.append("")
hour_hit = Counter(r["hour"] for r in all_win_day_hour)
if hour_hit:
    md.append("| Heure | # jours où ce créneau est 100% (n≥2) | Dates |")
    md.append("|------:|-------------------------------------:|:------|")
    for h, c in sorted(hour_hit.items(), key=lambda x: (-x[1], x[0])):
        dates = sorted(r["date"] for r in all_win_day_hour if r["hour"] == h)
        md.append(f"| {h:02d}h | {c} | {', '.join(dates)} |")
    md.append("")
else:
    md.append("_Aucun._")
    md.append("")

md.append("## 4. Synthèse concrète")
md.append("")
md.append("### Streaks =6 / ≥6")
md.append(f"- {len(streaks_eq6)} streaks **exactement 6** ; {len(streaks_ge6)} streaks **≥ 6** (table §1).")
if rec_eq6:
    md.append(
        "- Récurrence **exacte =6** même heure de début : "
        + ", ".join(f"{r['startHour']:02d}h ({r['distinctDays']} jours)" for r in rec_eq6)
        + "."
    )
else:
    md.append("- **Pas** de récurrence d'heure de début pour les streaks **exactement 6** sur ≥2 jours.")
if rec_ge6:
    md.append(
        "- Récurrence **≥6** même heure de début : "
        + ", ".join(f"{r['startHour']:02d}h ×{r['distinctDays']}j" for r in rec_ge6)
        + "."
    )
md.append("")
md.append("### Slots / jours all-win")
if all_win_days:
    md.append(f"- Jours 100% : {', '.join(r['bin']+' ('+r.get('weekday','')+')' for r in all_win_days)}.")
else:
    md.append("- **Aucun jour calendaire 100%.**")
if near_hours:
    md.append(
        "- Heures agrégées quasi-parfaites : "
        + ", ".join(f"{r['bin']} {r['wr']}% (n={r['n']})" for r in near_hours)
        + "."
    )
md.append(
    f"- Créneaux jour×heure 100% n≥3 : **{len(all_win_day_hour_n3)}** ; "
    f"jour×2h 100% n≥3 : **{len(all_win_day_2h)}** ; "
    f"jour×3h 100% n≥3 : **{len(all_win_day_3h)}** (détail §3)."
)
md.append("")
md.append("## 5. Caveats (petits n)")
md.append("")
md.append("- **n par heure agrégée ≈ 17–26**, 5–8 jours distincts : un WR 100% ou 95% sur un bin 1h reste **fragile** (IC larges ; voir rapport parent, 23h = 20/21).")
md.append("- Un créneau **jour × heure** à 100% avec n = 2–4 est attendu sous WR baseline 70% (P(4 wins) ≈ 24%) — **ne pas traiter comme un filtre**.")
md.append("- Seulement **~10 jours** de sim ; couverture horaire inégale (trous >2 h) ; sizing changé le 01/10.")
md.append("- Les streaks traversent les trous de sim ; définir autrement raccourcirait certains runs.")
md.append("- Aucun de ces créneaux 100% n'est un filtre validé ; pas de test de réplication hors période dans ce follow-up (le parent montrait que 23h ne se répliquait pas sur le backtest).")
md.append("- Métriques uniquement descriptives ici : pas de p-values nouvelles inventées.")
md.append("")
md.append("## 6. Fichiers")
md.append("")
md.append("- `streaks-6-and-allwin-slots-2026-10-05.json` — tables complètes.")
md.append("- `analyze_streaks6_allwin.py` — script de ce follow-up.")
md.append("- Données : `series-sim-15m.csv` (inchangé).")
md.append("")

md_path = HERE / "RAPPORT-streaks6-allwin-creneaux-2026-10-05.md"
md_path.write_text("\n".join(md), encoding="utf-8")
print("Wrote", json_path.name, "and", md_path.name)
print("streaks_ge6", len(streaks_ge6), "eq6", len(streaks_eq6))
print("all_win_days", len(all_win_days), "near_days", len(near_days))
print("near_hours", [(r["bin"], r["wr"], r["n"]) for r in near_hours])
print("all_win_day_hour_n3", len(all_win_day_hour_n3), "day2h", len(all_win_day_2h), "day3h", len(all_win_day_3h))
print("rec_ge6_start", [(r["startHour"], r["distinctDays"]) for r in rec_ge6])
print("rec_eq6_start", [(r["startHour"], r["distinctDays"]) for r in rec_eq6])
