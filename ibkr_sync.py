#!/usr/bin/env python3
"""Synchro IBKR -> gist du tableau de bord Patrimoine.

Récupère la valeur nette (NAV) du compte Interactive Brokers via le
Flex Web Service, puis l'ajoute au fichier patrimoine.json du gist.
Bibliothèque standard uniquement : rien à installer.

Variables d'environnement :
  IBKR_FLEX_TOKEN     jeton du Flex Web Service (Client Portal)
  IBKR_FLEX_QUERY_ID  ID de la Flex Query (section « Net Asset Value »)
  GIST_ID             ID du gist créé par l'appli
  GIST_TOKEN          token GitHub avec le droit « gist »
  IBKR_ACCOUNT_ID     (optionnel) id du compte dans l'appli, « ibkr » par défaut

Usage :
  python ibkr_sync.py               synchro normale (n'affiche aucun montant)
  python ibkr_sync.py --dry-run     affiche les valeurs trouvées, n'écrit rien
  python ibkr_sync.py --xml f.xml   lit un relevé Flex déjà téléchargé (test)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
GIST_FILE = "patrimoine.json"
RETRY_CODES = {"1001", "1004", "1005", "1006", "1007", "1008", "1009", "1018", "1019", "1021"}
USER_AGENT = "patrimoine-sync/1.0"


class SyncError(Exception):
    pass


# ---------------------------------------------------------------- HTTP
def http(url: str, *, method: str = "GET", headers: dict | None = None, body: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        raise SyncError(f"HTTP {err.code} sur {urllib.parse.urlsplit(url).netloc}") from None
    except urllib.error.URLError as err:
        raise SyncError(f"Réseau indisponible : {err.reason}") from None


# ---------------------------------------------------------------- IBKR Flex
def flex_fetch(token: str, query_id: str, attempts: int = 10) -> bytes:
    """Étape 1 : SendRequest -> code de référence. Étape 2 : GetStatement (avec attentes)."""
    q = urllib.parse.urlencode({"t": token, "q": query_id, "v": 3})
    root = ET.fromstring(http(f"{FLEX_BASE}/SendRequest?{q}"))
    if root.findtext("Status") != "Success":
        raise SyncError(f"SendRequest refusé ({root.findtext('ErrorCode')}) : {root.findtext('ErrorMessage')}")
    ref = root.findtext("ReferenceCode")

    q = urllib.parse.urlencode({"t": token, "q": ref, "v": 3})
    delay = 5
    for _ in range(attempts):
        time.sleep(delay)
        raw = http(f"{FLEX_BASE}/GetStatement?{q}")
        doc = ET.fromstring(raw)
        if doc.tag == "FlexQueryResponse":
            return raw
        code = doc.findtext("ErrorCode") or ""
        if code not in RETRY_CODES:
            raise SyncError(f"GetStatement refusé ({code}) : {doc.findtext('ErrorMessage')}")
        delay = min(delay * 2, 30)
    raise SyncError("Le relevé IBKR n'a pas été généré à temps, réessaie plus tard")


def norm_date(raw: str) -> str | None:
    raw = (raw or "").strip().split(";")[0]
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def parse_nav(xml_bytes: bytes) -> dict[str, float]:
    """Retourne {date ISO: valeur nette totale} (somme si plusieurs comptes IBKR)."""
    root = ET.fromstring(xml_bytes)
    navs: dict[str, float] = {}

    # Section « Net Asset Value (NAV) in Base » : une ligne par jour
    for el in root.iter("EquitySummaryByReportDateInBase"):
        date, total = norm_date(el.get("reportDate", "")), el.get("total")
        if date and total not in (None, ""):
            navs[date] = navs.get(date, 0.0) + float(total)

    # Repli : section « Change in NAV » (valeur de fin de période)
    if not navs:
        for el in root.iter("ChangeInNAV"):
            date, end = norm_date(el.get("toDate", "")), el.get("endingValue")
            if date and end not in (None, ""):
                navs[date] = navs.get(date, 0.0) + float(end)

    if not navs:
        raise SyncError("Aucune valeur nette trouvée : ajoute la section « Net Asset Value (NAV) in Base » à ta Flex Query")
    return {d: round(v, 2) for d, v in navs.items()}


# ---------------------------------------------------------------- Gist
def gist_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def gist_load(gist_id: str, token: str) -> dict:
    gist = json.loads(http(f"https://api.github.com/gists/{gist_id}", headers=gist_headers(token)))
    file = gist.get("files", {}).get(GIST_FILE)
    if not file:
        raise SyncError(f"Le gist ne contient pas {GIST_FILE} : crée-le d'abord depuis l'appli")
    content = file["content"]
    if file.get("truncated"):
        content = http(file["raw_url"]).decode("utf-8")
    return json.loads(content)


def gist_save(gist_id: str, token: str, data: dict) -> None:
    body = json.dumps({"files": {GIST_FILE: {"content": json.dumps(data, ensure_ascii=False, indent=1)}}}).encode()
    http(f"https://api.github.com/gists/{gist_id}", method="PATCH",
         headers={**gist_headers(token), "Content-Type": "application/json"}, body=body)


def merge(data: dict, navs: dict[str, float], account_id: str) -> int:
    """Ajoute/actualise les valeurs IBKR. Retourne le nombre de valeurs modifiées."""
    if not any(a.get("id") == account_id for a in data.setdefault("accounts", [])):
        data["accounts"].append({"id": account_id, "name": "Interactive Brokers",
                                 "color": "#3b6ea5", "source": "ibkr"})
    entries = data.setdefault("entries", [])
    index = {(e["date"], e["account"]): i for i, e in enumerate(entries)}
    changed = 0
    for date, value in sorted(navs.items()):
        new = {"date": date, "account": account_id, "value": value, "source": "ibkr"}
        i = index.get((date, account_id))
        if i is None:
            entries.append(new)
            changed += 1
        elif entries[i].get("value") != value:
            entries[i] = new
            changed += 1
    if changed:
        data["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return changed


# ---------------------------------------------------------------- Main
def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SyncError(f"Variable d'environnement manquante : {name}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Synchro IBKR -> gist Patrimoine")
    parser.add_argument("--dry-run", action="store_true", help="affiche les valeurs, n'écrit rien")
    parser.add_argument("--xml", help="relevé Flex local à utiliser au lieu de l'API")
    args = parser.parse_args()

    try:
        if args.xml:
            with open(args.xml, "rb") as f:
                raw = f.read()
        else:
            raw = flex_fetch(env("IBKR_FLEX_TOKEN"), env("IBKR_FLEX_QUERY_ID"))
        navs = parse_nav(raw)

        if args.dry_run:
            for date, value in sorted(navs.items()):
                print(f"{date}  {value:>14,.2f}")
            return 0

        gist_id, token = env("GIST_ID"), env("GIST_TOKEN")
        account_id = os.environ.get("IBKR_ACCOUNT_ID", "ibkr").strip() or "ibkr"
        data = gist_load(gist_id, token)
        changed = merge(data, navs, account_id)
        if changed:
            gist_save(gist_id, token, data)
        # Aucun montant affiché : les journaux GitHub Actions d'un dépôt public sont visibles de tous.
        print(f"OK : {changed} valeur(s) mise(s) à jour, dernier relevé du {max(navs)}.")
        return 0
    except SyncError as err:
        print(f"ERREUR : {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
