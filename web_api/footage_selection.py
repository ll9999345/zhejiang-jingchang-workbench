"""Pure metadata planning and global, bounded stock-footage assignment.

Metadata is never visual/location verification. No network, files, or project
mutation is performed here; callers supply probed candidate durations.
"""
from __future__ import annotations

import math
import re
from urllib.parse import unquote, urlsplit, parse_qs

INTENTS = [
    ('云海', 'cloud mist', ('云', '雾', 'cloud', 'mist', 'fog')),
    ('日出', 'sunrise', ('日出', '朝阳', 'sunrise', 'dawn')),
    ('日落', 'sunset', ('日落', '夕阳', '暮色', 'sunset', 'dusk')),
    ('栈道', 'walkway', ('栈道', '步道', 'walkway', 'trail', 'path')),
    ('峰林', 'peaks', ('峰', '岩', 'peaks', 'peak', 'rock', 'granite')),
    ('森林', 'forest', ('树', '林', '叶', 'forest', 'tree', 'woodland')),
    ('瀑布', 'waterfall', ('瀑布', 'waterfall')),
    ('湖面', 'lake', ('湖', '水面', '水纹', 'lake')),
    ('古镇', 'ancient town', ('古镇', '老街', '古城', 'ancient town')),
    ('夜景', 'night lights', ('灯', '夜', 'night', 'lights')),
    ('海浪', 'ocean', ('海浪', '海岸', 'ocean', 'coast')),
]


def norm(text):
    return re.sub(r'[^a-z0-9\u3400-\u9fff]+', '', unquote(str(text or '')).lower())


def metadata(record):
    return norm(' '.join(str(record.get(k) or '') for k in
                         ('source_url', 'source_tags', 'title', 'description')))


def place_aliases(chinese, english):
    short = english.removeprefix('Mount ').removesuffix(' Mountain').removesuffix(' Lake')
    aliases = [chinese, english, short]
    if chinese == '三清山':
        aliases.extend(['Sanqing Shan', 'Sanqingshan'])
    return list(dict.fromkeys(aliases))


def find_place(text, places):
    value = norm(text)
    return next((p for p, english in places.items()
                 if any(norm(a) in value for a in place_aliases(p, english))), '')


def intents(text):
    value = norm(text)
    return [row for row in INTENTS if any(norm(a) in (value.replace('峰林', '').replace('石林', '') if row[0] == '森林' else value) for a in row[2])]


def plan_queries(topic, text, override, places):
    place = find_place(topic + ' ' + text, places)
    if override:
        # A generic override in a named-place project still needs that anchor.
        query = override.strip()
        if place and not find_place(query, places):
            query = place + ' ' + query
        return [{'text': query, 'kind': 'place'}]
    broad = place or re.split(r'[，,。；;：:\n]', topic)[0].strip()[:80] or text[:60]
    rows = [{'text': broad, 'kind': 'place'}]
    if place:
        rows.append({'text': places[place], 'kind': 'place'})
    subjects = intents(text)[:2]
    if place:
        for chinese, english, _ in subjects:
            rows.extend([{'text': f'{place} {chinese}', 'kind': 'place_intent'},
                         {'text': f'{places[place]} {english}', 'kind': 'place_intent'}])
    # Explicitly opt-in illustrative footage remains distinguishable in receipts.
    for _, english, _ in subjects:
        rows.append({'text': english, 'kind': 'generic'})
    seen = set()
    return [r for r in rows if r['text'] and not (r['text'].lower() in seen or seen.add(r['text'].lower()))]


def query_groups(query, places):
    place = find_place(query, places)
    if place:
        groups = [place_aliases(place, places[place])]
        # Remove place words before interpreting shot intent (West Lake is a
        # place anchor; its word "Lake" alone is not a separate intent).
        remainder = norm(query)
        for alias in sorted(place_aliases(place, places[place]), key=len, reverse=True):
            remainder = remainder.replace(norm(alias), '')
        subjects = intents(remainder)
        groups.extend(list(row[2]) for row in subjects)
        # Preserve unfamiliar explicit keywords rather than reducing every
        # override to a location-only search (e.g. Sanqing restaurant).
        for row in subjects:
            for term in sorted([row[0], row[1], *row[2]], key=len, reverse=True):
                remainder = remainder.replace(norm(term), '')
        if len(remainder) >= 3 or re.search(r'[\u3400-\u9fff]', remainder):
            groups.append([remainder])
        return groups
    matched = intents(query)
    if matched:
        return [list(row[2]) for row in matched]
    words = re.findall(r'[a-z0-9]{3,}|[\u3400-\u9fff]+', query.lower())
    return [[word] for word in words]


def matches_query(record, query, places):
    groups = query_groups(query, places)
    value = metadata(record)
    return bool(groups) and all(any(norm(term) in value for term in group) for group in groups)


def asset_key(candidate):
    """Same source page is one asset, even when downloaded to several jobs."""
    if candidate.get('asset_key'):
        return candidate['asset_key']
    source = str(candidate.get('source') or '')
    identity = candidate.get('source_id') or candidate.get('clip_id')
    if identity:
        return source + ':' + str(identity)
    return _url_key(candidate) or 'path:' + str(candidate.get('path') or '')


def _url_key(candidate):
    url = str(candidate.get('source_url') or '').strip()
    if url:
        u = urlsplit(unquote(url))
        title = parse_qs(u.query).get('title', [''])[0]
        page = '/wiki/' + title if title else u.path
        return 'url:' + (u.netloc + page).rstrip('/').lower()
    return ''


def _aliases(candidate):
    return list(dict.fromkeys([asset_key(candidate), _url_key(candidate),
                              'path:' + str(candidate.get('path') or '')] +
                             (candidate.get('asset_aliases') or [])))


def is_manual(shot):
    # Unmarked existing selections are preserved conservatively.
    return bool(shot.get('source_path') and
                (shot.get('source_locked') or shot.get('selection_mode') != 'auto'))


def deduplicate_records(records):
    records = list(records)
    parents, owners = list(range(len(records))), {}
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i, record in enumerate(records):
        for alias in _aliases(record):
            if not alias or alias == 'path:':
                continue
            if alias in owners:
                a, b = root(i), root(owners[alias])
                parents[max(a, b)] = min(a, b)
            else:
                owners[alias] = i
    result = {}
    for i, record in enumerate(records):
        key = root(i)
        previous = result.get(key)
        if previous is None:
            result[key] = dict(record)
            result[key]['asset_key'] = asset_key(record)
            result[key]['asset_aliases'] = _aliases(record)
            continue
        # Keep the path and duration from the same probe; merge only metadata.
        aliases, canonical_key = previous['asset_aliases'], previous['asset_key']
        if not previous.get('duration') and record.get('duration'):
            previous.update(record)
        previous['asset_key'] = canonical_key
        for field in ('title', 'source_tags', 'creator', 'license', 'source_id'):
            if not previous.get(field) and record.get(field):
                previous[field] = record[field]
        previous['shot_ids'] = list(dict.fromkeys((previous.get('shot_ids') or []) + (record.get('shot_ids') or [])))
        previous['queries'] = list(dict.fromkeys((previous.get('queries') or [previous.get('query')]) +
                                                (record.get('queries') or [record.get('query')])))
        previous['asset_aliases'] = list(dict.fromkeys(aliases + _aliases(record)))
    return list(result.values())


def _duration(candidate):
    if str(candidate.get('path') or '').lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
        return math.inf
    try:
        value = float(candidate.get('duration') or 0)
        return value if math.isfinite(value) and value > 0 else 0
    except (TypeError, ValueError):
        return 0


def _offset(candidate, duration, occupied):
    total = _duration(candidate)
    if total < duration:
        return None
    if math.isinf(total):
        return None if occupied else 0.0
    cursor = 0.0
    for start, end in sorted(occupied):
        if cursor + duration <= start:
            return cursor
        cursor = max(cursor, end)
    return cursor if cursor + duration <= total else None


def _affinity_scores(shots):
    # These caches belong to one assignment only. A later edit must recompute
    # its scores, and no project text is persisted or retained across jobs.
    subjects, descriptions, scores = {}, {}, {}
    def score(index, candidate):
        if index not in subjects:
            shot = shots[index]
            rows = intents(' '.join(str(shot.get(k) or '') for k in ('title', 'text', 'visual_prompt', 'query')))
            subjects[index] = [tuple(norm(a) for a in row[2]) for row in rows]
        fields = tuple(str(candidate.get(k) or '') for k in ('source_url', 'source_tags', 'title', 'description'))
        illustrative = candidate.get('match_kind') == 'illustrative'
        key = (index, fields, illustrative)
        if key not in scores:
            if fields not in descriptions:
                descriptions[fields] = norm(' '.join(fields))
            matched = sum(any(term in descriptions[fields] for term in group) for group in subjects[index])
            scores[key] = matched * 20 - (40 if illustrative else 0)
        return scores[key]
    return score


def _distinct_assignment(shots, options, manual_assets, affinity):
    """Maximize distinct allocations first, then total metadata affinity.

    Rectangular minimum-cost assignment with one dummy column per shot.
    A missing-shot penalty dominates every possible affinity difference, so
    a better keyword match never takes away a constrained shot's only source.
    At most 60 rows enter through FootageRequest; no new dependency is needed.
    """
    order = sorted(options, key=lambda i: (len(options[i]), -float(shots[i]['duration_seconds'])))
    choices = [{key: candidate for key, candidate in options[i] if key not in manual_assets}
               for i in order]
    keys = list(dict.fromkeys(key for row in choices for key in row))
    if not keys:
        return {}
    scores = [{key: affinity(i, candidate) for key, candidate in row.items()}
              for i, row in zip(order, choices)]
    values = [score for row in scores for score in row.values()]
    high, low = max(values), min(values)
    n, real_columns = len(order), len(keys)
    missing = (n + 1) * (high - low + 1)
    forbidden = n * missing + 1
    costs = [[high - row[key] if key in row else forbidden for key in keys] + [missing] * n
             for row in scores]
    columns = real_columns + n
    # One-based row/column potentials and alternating augmenting paths.
    u, v = [0] * (n + 1), [0] * (columns + 1)
    owner, previous = [0] * (columns + 1), [0] * (columns + 1)
    for row in range(1, n + 1):
        owner[0], column = row, 0
        best, visited = [math.inf] * (columns + 1), [False] * (columns + 1)
        while True:
            visited[column] = True
            active, delta, next_column = owner[column], math.inf, 0
            for j in range(1, columns + 1):
                if visited[j]:
                    continue
                cost = costs[active - 1][j - 1] - u[active] - v[j]
                if cost < best[j]:
                    best[j], previous[j] = cost, column
                if best[j] < delta:
                    delta, next_column = best[j], j
            for j in range(columns + 1):
                if visited[j]:
                    u[owner[j]] += delta
                    v[j] -= delta
                else:
                    best[j] -= delta
            column = next_column
            if not owner[column]:
                break
        while column:
            predecessor = previous[column]
            owner[column] = owner[predecessor]
            column = predecessor
    return {order[owner[j] - 1]: (keys[j - 1], choices[owner[j] - 1][keys[j - 1]])
            for j in range(1, real_columns + 1)
            if owner[j] and keys[j - 1] in choices[owner[j] - 1]}


def assign_automatic(shots, *, allow_generic=False, valid=None):
    """Assign distinct source assets globally, then nonoverlapping reuse windows.

    Weighted assignment protects constrained shots from a flexible shot taking
    their only asset while keeping the strongest overall metadata matches.
    Existing manual selections reserve their intervals.
    Unknown/short footage and exhausted windows remain missing, with a receipt.
    """
    warnings, occupied, options, manual_assets = [], {}, {}, set()
    affinity = _affinity_scores(shots)
    all_records = {c.get('path'): c for s in shots for c in s.get('candidates', [])}
    catalog = deduplicate_records(list(all_records.values()) + [s['selected_source'] for s in shots if s.get('selected_source')])
    canonical = {alias: asset_key(c) for c in catalog for alias in _aliases(c) if alias and alias != 'path:'}
    def identity(c):
        return next((canonical[a] for a in _aliases(c) if a in canonical), asset_key(c))
    for shot in shots:
        if not is_manual(shot):
            continue
        candidate = shot.get('selected_source') or all_records.get(shot['source_path']) or {'path': shot['source_path']}
        key = identity(candidate)
        manual_assets.add(key)
        start = float(shot.get('start_seconds') or 0)
        end = math.inf if math.isinf(_duration(candidate)) else start + float(shot['duration_seconds'])
        occupied.setdefault(key, []).append((start, end))
    for index, shot in enumerate(shots):
        if is_manual(shot) or shot.get('source_locked'):
            continue
        unique = {}
        for candidate in shot.get('candidates') or []:
            if (valid and not valid(candidate)) or not candidate.get('path'):
                continue
            if candidate.get('match_kind') == 'illustrative' and not allow_generic:
                continue
            if re.search(r'by-nc-nd|by-nd|no.?derivatives|禁止.*改编', str(candidate.get('license') or ''), re.I):
                continue
            key = identity(candidate)
            if _offset(candidate, float(shot['duration_seconds']), occupied.get(key, [])) is None:
                continue
            if key not in unique or affinity(index, candidate) > affinity(index, unique[key]):
                unique[key] = candidate
        options[index] = sorted(unique.items(), key=lambda row: (
            row[0] in manual_assets, -affinity(index, row[1])))
        shot['source_path'] = ''
        shot.pop('selected_source', None)
        shot.pop('selection_reason', None)
        shot.pop('selection_warning', None)
        shot['selection_mode'] = 'auto'
    assignment = _distinct_assignment(shots, options, manual_assets, affinity)
    reused, missing, selected = [], [], []
    # Commit distinct allocations before considering reuse. This preserves a
    # later constrained shot's one usable window from earlier reuse requests.
    def commit(index, key, candidate, start):
        shot = shots[index]
        already = bool(occupied.get(key))
        shot.update(source_path=candidate['path'], start_seconds=start,
                    selected_source=dict(candidate, asset_key=key), selection_mode='auto',
                    selection_reason='distinct_source' if not already else 'nonoverlapping_source_segment')
        end = math.inf if math.isinf(_duration(candidate)) else start + float(shot['duration_seconds'])
        occupied.setdefault(key, []).append((start, end))
        selected.append({'shot_id': shot['id'], 'asset_key': key, 'start_seconds': start,
                         'duration_seconds': shot['duration_seconds'], 'reason': shot['selection_reason']})
        if already:
            reused.append(shot['id'])
            shot['selection_warning'] = '独立候选不足，使用同源不重叠片段；这不是新增素材，请预览确认。'
        if intents(' '.join(str(shot.get(k) or '') for k in ('title', 'text', 'visual_prompt'))) and affinity(index, candidate) <= 0:
            warnings.append(f"镜头 {shot['id']} 仅有地点候选，来源元信息未确认镜头意图；请预览画面。")
            shot['selection_warning'] = (shot.get('selection_warning', '') + ' 来源元信息未确认镜头意图。').strip()
    for index, (key, candidate) in sorted(assignment.items()):
        start = _offset(candidate, float(shots[index]['duration_seconds']), occupied.get(key, []))
        if start is not None:
            commit(index, key, candidate, start)
    for index, choices in options.items():
        if shots[index].get('source_path'):
            continue
        for key, candidate in sorted(choices, key=lambda row: (len(occupied.get(row[0], [])), -affinity(index, row[1]))):
            start = _offset(candidate, float(shots[index]['duration_seconds']), occupied.get(key, []))
            if start is not None:
                commit(index, key, candidate, start)
                break
        else:
            missing.append(shots[index]['id'])
            shots[index]['selection_warning'] = '没有足够长且未占用的合适片段，请补充素材；不会重复入点或用无关画面填充。'
    unique_count = len({key for choices in options.values() for key, _ in choices})
    if unique_count < len(options):
        warnings.append(f'合适独立素材只有 {unique_count} 个，待自动选片镜头 {len(options)} 个；同源不同片段仍不是新增素材。')
    if reused:
        warnings.append('镜头 ' + '、'.join(reused) + ' 使用同源不重叠片段；地点和镜头内容仍须预览确认。')
    if missing:
        warnings.append('镜头 ' + '、'.join(missing) + ' 没有足够长且未占用的合适片段；未重复入点或以无关画面填充。')
    return {'selected': selected, 'manual_shots': [s['id'] for s in shots if is_manual(s)],
            'missing_shots': missing, 'unique_assets_available': unique_count,
            'reused_source_shots': reused, 'warnings': list(dict.fromkeys(warnings))}
