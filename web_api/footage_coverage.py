"""Read-only coverage of selected, probed timeline windows, never provider claims."""
from __future__ import annotations
import math


def _number(value):
    if isinstance(value,bool): raise ValueError('Invalid timing')
    value=float(value)
    if not math.isfinite(value) or value < 0: raise ValueError('Invalid timing')
    return value


def selected_window_coverage(shots, measure):
    """Only a complete supported window counts. A short file stays uncovered.

    Repeated manual windows can intentionally occupy multiple timeline slots;
    this is timeline coverage, not distinct scene count or geographic proof.
    ``measure`` is the caller's safe local-path probe, cached by path per audit.
    """
    cache, rows = {}, []
    required_total = covered_total = 0.
    for shot in shots:
        identity=str(shot.get('id') or '')
        try:
            required=_number(shot['duration_seconds'])
            start=_number(shot.get('start_seconds') or 0)
            if required <= 0: raise ValueError('Invalid duration')
        except (ValueError,TypeError,KeyError,OverflowError):
            rows.append({'shot_id':identity,'covered':False,'reason':'invalid_timing','required_seconds':0.})
            continue
        required_total += required
        path=shot.get('source_path')
        reason, covered = 'missing_source', False
        if path:
            if path not in cache:
                try: cache[path]=measure(path)
                except Exception: cache[path]=None
            info=cache[path]
            try:
                if not info or info.get('has_video') is not True: raise ValueError('No visual stream')
                duration=_number(info.get('duration') or 0)
                still=info.get('is_still') is True
                if still and duration == 0:
                    covered,reason = True,'probed_still_image_hold'
                elif start+required <= duration+1e-6:
                    covered,reason = True,'probed_video_window'
                else: reason='window_exceeds_source'
            except (ValueError,TypeError,OverflowError): reason='probe_failed'
        if covered: covered_total += required
        rows.append({'shot_id':identity,'covered':covered,'reason':reason,'required_seconds':round(required,3)})
    missing=[row['shot_id'] for row in rows if not row['covered']]
    return {'evidence':'probed_selected_windows','required_seconds':round(required_total,3),
            'covered_seconds':round(covered_total,3),'missing_seconds':round(max(0.,required_total-covered_total),3),
            'fraction':min(1.,covered_total/required_total) if required_total > 0 else 0.,
            'ready_shots':len(rows)-len(missing),'total_shots':len(rows),'missing_shot_ids':missing,
            'rows':rows,'location_verified':False,'quality_review_required':True}
