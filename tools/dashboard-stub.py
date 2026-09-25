"""Dependency-free stub of the three backends for working on the dashboard without Postgres.

Serves public/dashboard/ plus the GET endpoints the dashboard uses, straight from src/data/*.json in each
backend's wire dialect. Writes are accepted and echoed (nothing is stored), so forms can be clicked
through but results are not real. Also imported by tools/build-postman.py for example responses.

    python3 tools/dashboard-stub.py [port]     # or: npm run dashboard:stub
    open http://127.0.0.1:8765/dashboard/

Not a substitute for the real server: validate business rules against Postgres before shipping.
"""
import json, re, base64
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
erp = json.load(open(ROOT / 'src/data/erp.json'))
srm = json.load(open(ROOT / 'src/data/srm.json'))
tms = json.load(open(ROOT / 'src/data/tms.json'))
STATUS = {'01': 'Open', '02': 'Partially confirmed', '03': 'Confirmed', '04': 'In delivery', '05': 'Closed', '09': 'Cancelled'}
MS = {'PLN': 'Planned - ASN drafted, not yet tendered', 'TND': 'Tendered - ASN submitted to carrier', 'ITR': 'In transit', 'DLV': 'Delivered', 'EXC': 'Exception - delayed or on hold', 'CXL': 'Cancelled'}
sap = lambda d: d.replace('-', '') if d else None
def sapts(t): return re.sub(r'[-:TZ]', '', t)[:14] if t else None
def f3(v): return f"{float(v or 0):.3f}"

def map_item(i):
    return {'item_no': i['item_no'], 'material': i['material'], 'short_text': i['short_text'], 'quantity': f3(i['quantity']), 'uom': i['uom'],
            'net_price': f"{i['net_price']:.2f}", 'price_unit': 1, 'confirmed_qty': f3(i.get('confirmed_qty')), 'confirmed_date': sap(i.get('confirmed_date')),
            'shipped_qty': f3(i.get('shipped_qty')), 'open_qty': f3(max(0, i['quantity'] - (i.get('shipped_qty') or 0))), 'reject_reason': i.get('reject_reason')}
PLANTS = {x['plant_code']: x for x in erp['plants']}
ORGS = {x['code']: x for x in erp['purchasing_orgs']}
def map_po(p, items=True, count=False):
    """ERP purchase order as the API returns it: ship-to address, buying org name and items embedded."""
    pl = PLANTS.get(p['plant'])
    o = {'po_number': p['po_number'], 'vendor_id': p['vendor_id'], 'purch_org': p['purch_org'], 'purch_org_name': ORGS.get(p['purch_org'], {}).get('name'),
         'doc_date': sap(p['doc_date']), 'currency': p['currency'], 'status_code': p['status_code'], 'status_text': STATUS[p['status_code']],
         'delivery_date': sap(p['delivery_date']), 'plant': p['plant'],
         'ship_to': {k: pl[k] for k in ('site_code', 'name', 'street', 'city', 'region', 'postal_code', 'country')} if pl else None,
         'incoterms': p['incoterms'], 'payment_terms': p['payment_terms'], 'buyer_name': p['buyer_name'], 'revision': p['revision'],
         'created_at': sapts(p['created_at']), 'changed_at': sapts(p['changed_at'])}
    if count: o['item_count'] = len(p['items'])  # list responses only
    if items: o['items'] = [map_item(i) for i in p['items']]
    return o
def map_conf(c):
    po = next(p for p in erp['purchase_orders'] if p['po_number'] == c['po_number'])
    return {**{k: c[k] for k in ('confirmation_no', 'po_number', 'po_revision', 'conf_category', 'vendor_reference', 'note', 'status', 'items')}, 'posted_at': sapts(c['posted_at']), 'vendor_id': po['vendor_id']}
def map_del(d): return {**d, 'posted_at': sapts(d['posted_at']), 'reversed_at': sapts(d.get('reversed_at'))}
def page(rows, q):
    pg, lim = int(q.get('page', 1)), int(q.get('limit', 25))
    return {'data': rows[(pg - 1) * lim: pg * lim], 'pagination': {'page': pg, 'limit': lim, 'total': len(rows), 'totalPages': -(-len(rows) // lim), 'hasNext': pg * lim < len(rows)}}

def map_contact(c): return {'contactId': c['contact_id'], 'role': c['role'], 'name': c['full_name'], 'email': c['email'], 'phone': c['phone'], 'supplierCode': c['supplier_code']}
def map_site(s): return {'siteCode': s['site_code'], 'supplierCode': s['supplier_code'], 'type': s['site_type'], 'name': s['name'], 'address': {'line1': s['address_line1'], 'city': s['city'], 'region': s['region'], 'postalCode': s['postal_code'], 'countryCode': s['country']}, 'active': s['active']}
def map_sup(s, kids=False):
    o = {'supplierCode': s['supplier_code'], 'erpVendorNumber': s['erp_vendor_number'], 'name': {'legal': s['legal_name'], 'trading': s['trading_name']}, 'status': s['status'], 'statusReason': s['status_reason'],
         'classification': {'tier': s['tier'], 'riskRating': s['risk_rating']}, 'capabilities': {'portal': s['portal_enabled'], 'asn': s['asn_enabled']}, 'countryCode': s['country'], 'duns': s['duns'], 'onboardedOn': s['onboarded_on'], 'updatedAt': '2026-09-20T10:00:00.000Z'}
    if kids:
        o['contacts'] = [map_contact(c) for c in srm['contacts'] if c['supplier_code'] == s['supplier_code']]
        o['sites'] = [map_site(x) for x in srm['sites'] if x['supplier_code'] == s['supplier_code']]
    return o
def map_ent(e): return {'consumerId': e['consumer_id'], 'displayName': e['display_name'], 'consumerType': e['consumer_type'], 'allSuppliers': '*' in e['supplier_codes'], 'suppliers': [x for x in e['supplier_codes'] if x != '*'], 'scopes': e['scopes'], 'active': e['active'], 'costCenter': e['cost_center'], 'contactEmail': e['contact_email'], 'updatedAt': '2026-09-01T00:00:00.000Z'}
def offset(rows, q):
    o, l = int(q.get('offset', 0)), int(q.get('limit', 20))
    return {'total': len(rows), 'offset': o, 'limit': l, 'items': rows[o:o + l]}

CAR = {c['scac']: c for c in tms['carriers']}
def map_shp(s, events=False):
    c = CAR[s['carrier_scac']]
    o = {'shipmentId': s['shipment_id'], 'asnNumber': s['asn_number'], 'supplierCode': s['supplier_code'],
         'carrier': {'scac': c['scac'], 'carrierCode': c['carrier_code'], 'name': c['name'], 'trackingId': s['tracking_id'],
                     'trackingUrl': c['tracking_url_template'].replace('{trackingId}', s['tracking_id']) if c.get('tracking_url_template') and s.get('tracking_id') else None},
         'milestone': {'code': s['milestone'], 'description': MS[s['milestone']], 'since': s['milestone_since']}, 'route': {'origin': s['origin'], 'destination': s['destination']},
         'schedule': {'plannedShipDate': s['planned_ship_at'], 'estimatedArrival': s['eta']}, 'contents': s['contents'], 'handlingUnits': s['handling_units'], 'cancelReason': s.get('cancel_reason'),
         'audit': {'createdAt': s['created_at'], 'updatedAt': s['updated_at']}}
    if events: o['events'] = map_events(s)
    return o
def map_events(s):
    return [{'eventId': 1000 + n, 'code': e['event_code'], 'description': e['description'], 'location': e['location'], 'occurredAt': e['occurred_at'], 'recordedAt': e['occurred_at']}
            for n, e in enumerate(s.get('events', []))]

def check(consumer, q):
    """Same decision logic as SRM GET /entitlements/{consumerId}/check."""
    e = next(x for x in srm['entitlements'] if x['consumer_id'] == consumer)
    scope, allow_all = q.get('scope'), '*' in e['supplier_codes']
    code, vendor = q.get('supplierCode'), q.get('erpVendorNumber')
    sup = next((x for x in srm['suppliers'] if (code and x['supplier_code'] == code) or (not code and vendor and x['erp_vendor_number'] == vendor)), None)
    asked = bool(code or vendor)
    allowed, reason = True, 'OK'
    if not e['active']: allowed, reason = False, 'CONSUMER_INACTIVE'
    elif scope not in e['scopes']: allowed, reason = False, 'SCOPE_NOT_GRANTED'
    elif asked and not sup: allowed, reason = False, 'SUPPLIER_NOT_FOUND'
    elif sup and not allow_all and sup['supplier_code'] not in e['supplier_codes']: allowed, reason = False, 'SUPPLIER_SCOPE_DENIED'
    elif sup and scope == 'supplier-orders.write' and sup['status'] != 'ACTIVE': allowed, reason = False, 'SUPPLIER_BLOCKED' if sup['status'] == 'BLOCKED' else 'SUPPLIER_ON_HOLD'
    vendors = [x for x in srm['suppliers'] if allow_all or x['supplier_code'] in e['supplier_codes']]
    return {'consumerId': e['consumer_id'], 'consumerType': e['consumer_type'], 'scope': scope, 'supplierCode': sup['supplier_code'] if sup else code, 'allowed': allowed, 'reason': reason,
            'supplier': {'supplierCode': sup['supplier_code'], 'erpVendorNumber': sup['erp_vendor_number'], 'legalName': sup['legal_name'], 'status': sup['status'], 'asnEnabled': sup['asn_enabled']} if sup else None,
            'allowedSuppliers': ['*'] if allow_all else e['supplier_codes'],
            'allowedVendors': [{'supplierCode': x['supplier_code'], 'erpVendorNumber': x['erp_vendor_number']} for x in sorted(vendors, key=lambda x: x['supplier_code'])],
            'evaluatedAt': '2026-09-24T12:00:00.000Z'}
CONF_CATEGORIES = {'AB': 'Order acknowledgement - accepted as ordered', 'AC': 'Order acknowledgement - accepted with changes', 'RJ': 'Order rejected by vendor'}
EVENT_CODES = [('PU', 'Picked up by carrier', 'ITR'), ('DEP', 'Departed facility', 'ITR'), ('ARR', 'Arrived at facility', 'ITR'), ('OFD', 'Out for delivery', 'ITR'),
               ('RES', 'Exception resolved - movement resumed', 'ITR'), ('DLV', 'Delivered', 'DLV'), ('EXC', 'Exception - shipment delayed', 'EXC')]
def map_carrier(c): return {'carrierCode': c['carrier_code'], 'scac': c['scac'], 'name': c['name'], 'mode': c['mode'], 'trackingUrlTemplate': c['tracking_url_template']}

def csv(q, k): return [x for x in (q.get(k) or '').split(',') if x]

def route(method, path, q, body):
    m = re.match(r'^/(erp|srm|tms)(/.*)$', path)
    if not m: return 404, {'error': 'no route'}
    svc, p = m.groups()
    if p == '/health': return 200, {'status': 'ok'}
    if method == 'POST' and svc == 'srm':
        mm = re.match(r'^/v1/entitlements/([^/]+)/check$', p)
        if mm: return 200, check(mm.group(1), body or {})
    if method != 'GET':
        # echo-style writes so forms can complete
        if svc == 'tms' and p == '/v1/shipments':
            s = dict(tms['shipments'][0]); s.update(shipment_id='SHP-20260924-00200', milestone='TND' if body.get('tender') else 'PLN'); return 201, map_shp(s)
        if svc == 'erp' and p == '/v1/purchase-orders': return 201, {'data': map_po(erp['purchase_orders'][0], True)}
        if method == 'DELETE': return 204, None
        return 200, {'data': {}, 'ok': True}
    if svc == 'erp':
        if p == '/v1/purchase-orders':
            rows = erp['purchase_orders']
            for k in ('status_code:status', 'vendor_id:vendor_id', 'plant:plant', 'purch_org:purch_org', 'po_number:po_number'):
                f, qk = k.split(':')
                if csv(q, qk): rows = [r for r in rows if r[f] in csv(q, qk)]
            rows = sorted(rows, key=lambda r: r['po_number'])
            return 200, page([map_po(r, True, True) for r in rows], q)
        mm = re.match(r'^/v1/purchase-orders/(\d+)(/confirmations|/items)?$', p)
        if mm:
            po = next((x for x in erp['purchase_orders'] if x['po_number'] == mm.group(1)), None)
            if not po: return 404, {'error': {'code': 'PO_NOT_FOUND', 'message': f'Purchase order {mm.group(1)} does not exist'}}
            if mm.group(2) == '/confirmations': return 200, {'data': [map_conf(c) for c in erp['confirmations'] if c['po_number'] == po['po_number']]}
            if mm.group(2) == '/items': return 200, {'data': [map_item(i) for i in po['items']]}
            return 200, {'data': map_po(po, True)}
        if p == '/v1/reference/status-codes': return 200, {'data': [{'status_code': k, 'status_text': v} for k, v in STATUS.items()]}
        if p == '/v1/reference/confirmation-categories': return 200, {'data': [{'conf_category': k, 'text': v} for k, v in CONF_CATEGORIES.items()]}
        if p == '/v1/confirmations':
            rows = [map_conf(c) for c in erp['confirmations']]
            if csv(q, 'status'): rows = [r for r in rows if r['status'] in csv(q, 'status')]
            if csv(q, 'conf_category'): rows = [r for r in rows if r['conf_category'] in csv(q, 'conf_category')]
            if csv(q, 'po_number'): rows = [r for r in rows if r['po_number'] in csv(q, 'po_number')]
            if csv(q, 'vendor_id'): rows = [r for r in rows if r['vendor_id'] in csv(q, 'vendor_id')]
            return 200, page(rows, q)
        mm = re.match(r'^/v1/confirmations/(\d+)$', p)
        if mm: return 200, {'data': next(map_conf(c) for c in erp['confirmations'] if c['confirmation_no'] == mm.group(1))}
        if p == '/v1/inbound-deliveries':
            rows = erp['inbound_deliveries']
            if q.get('status'): rows = [r for r in rows if r['status'] == q['status']]
            if q.get('asn_reference'): rows = [r for r in rows if r['asn_reference'] == q['asn_reference']]
            if q.get('vendor_id'): rows = [r for r in rows if r['vendor_id'] == q['vendor_id']]
            if q.get('po_number'): rows = [r for r in rows if any(i['po_number'] == q['po_number'] for i in r['items'])]
            return 200, page([map_del(r) for r in rows], q)
        mm = re.match(r'^/v1/inbound-deliveries/(\d+)$', p)
        if mm: return 200, {'data': map_del(next(d for d in erp['inbound_deliveries'] if d['delivery_no'] == mm.group(1)))}
        if p == '/v1/plants': return 200, {'data': [x for x in erp['plants'] if not q.get('site_code') or x['site_code'] == q['site_code']]}
        mm = re.match(r'^/v1/plants/(\w+)$', p)
        if mm: return 200, {'data': next(x for x in erp['plants'] if x['plant_code'] == mm.group(1))}
        if p == '/v1/reference/purchasing-orgs': return 200, {'data': erp['purchasing_orgs']}
        mm = re.match(r'^/v1/reference/purchasing-orgs/(\w+)$', p)
        if mm: return 200, {'data': next(x for x in erp['purchasing_orgs'] if x['code'] == mm.group(1))}
    if svc == 'srm':
        if p == '/v1/suppliers':
            rows = srm['suppliers']
            if csv(q, 'status'): rows = [r for r in rows if r['status'] in csv(q, 'status')]
            if q.get('q'): rows = [r for r in rows if q['q'].lower() in r['legal_name'].lower()]
            if csv(q, 'tier'): rows = [r for r in rows if r['tier'] in csv(q, 'tier')]
            if csv(q, 'country'): rows = [r for r in rows if r['country'] in csv(q, 'country')]
            return 200, offset([map_sup(r, 'sites' in csv(q, 'expand')) for r in rows], q)
        mm = re.match(r'^/v1/suppliers/(SUP-\d+)(/sites|/contacts)?$', p)
        if mm:
            s = next(x for x in srm['suppliers'] if x['supplier_code'] == mm.group(1))
            if mm.group(2) == '/sites':
                rows = [map_site(x) for x in srm['sites'] if x['supplier_code'] == s['supplier_code'] and (not q.get('type') or x['site_type'] == q['type'])]
                return 200, {'total': len(rows), 'items': rows}
            if mm.group(2) == '/contacts':
                rows = [map_contact(x) for x in srm['contacts'] if x['supplier_code'] == s['supplier_code'] and (not q.get('role') or x['role'] == q['role'])]
                return 200, {'total': len(rows), 'items': [{k: v for k, v in r.items() if k != 'supplierCode'} for r in rows]}
            return 200, map_sup(s, True)
        if p == '/v1/sites': return 200, offset([map_site(x) for x in srm['sites'] if (not q.get('supplierCode') or x['supplier_code'] == q['supplierCode']) and (not q.get('type') or x['site_type'] == q['type']) and (not q.get('country') or x['country'] == q['country'])], q)
        mm = re.match(r'^/v1/sites/(.+)$', p)
        if mm: return 200, map_site(next(x for x in srm['sites'] if x['site_code'] == mm.group(1)))
        if p == '/v1/contacts': return 200, offset([map_contact(x) for x in srm['contacts'] if not q.get('role') or x['role'] == q['role']], q)
        mm = re.match(r'^/v1/contacts/(.+)$', p)
        if mm: return 200, map_contact(next(x for x in srm['contacts'] if x['contact_id'] == mm.group(1)))
        if p == '/v1/entitlements': return 200, {'total': len(srm['entitlements']), 'items': [map_ent(e) for e in srm['entitlements']]}
        mm = re.match(r'^/v1/entitlements/([^/]+)/check$', p)
        if mm: return 200, check(mm.group(1), {**q, **(body or {})})
        mm = re.match(r'^/v1/entitlements/([^/]+)$', p)
        if mm: return 200, map_ent(next(e for e in srm['entitlements'] if e['consumer_id'] == mm.group(1)))
        mm = re.match(r'^/v1/vendor-xref/(\d+)$', p)
        if mm:
            x = next(s for s in srm['suppliers'] if s['erp_vendor_number'] == mm.group(1))
            return 200, {'supplierCode': x['supplier_code'], 'erpVendorNumber': x['erp_vendor_number'], 'status': x['status'], 'legalName': x['legal_name']}
        if p == '/v1/vendor-xref':
            vs = csv(q, 'erpVendorNumber')
            items = [{'supplierCode': s['supplier_code'], 'erpVendorNumber': s['erp_vendor_number'], 'status': s['status'], 'legalName': s['legal_name']} for s in srm['suppliers'] if s['erp_vendor_number'] in vs]
            return 200, {'items': items, 'unresolved': [v for v in vs if v not in {i['erpVendorNumber'] for i in items}]}
    if svc == 'tms':
        if p == '/v1/shipments':
            rows = sorted(tms['shipments'], key=lambda s: s['shipment_id'], reverse=True)
            if csv(q, 'status'): rows = [r for r in rows if r['milestone'] in csv(q, 'status')]
            if csv(q, 'supplierCode'): rows = [r for r in rows if r['supplier_code'] in csv(q, 'supplierCode')]
            if q.get('poNumber'): rows = [r for r in rows if any(c['poNumber'] == q['poNumber'] for c in r['contents'])]
            if q.get('asnNumber'): rows = [r for r in rows if r['asn_number'] == q['asnNumber']]
            if csv(q, 'carrier'): rows = [r for r in rows if r['carrier_scac'] in csv(q, 'carrier') or CAR[r['carrier_scac']]['carrier_code'] in csv(q, 'carrier')]
            if q.get('cursor'): rows = [r for r in rows if r['shipment_id'] < base64.b64decode(q['cursor']).decode()]
            lim = int(q.get('limit', 25)); pg = rows[:lim]
            return 200, {'count': len(pg), 'results': [map_shp(s) for s in pg], 'nextCursor': base64.b64encode(pg[-1]['shipment_id'].encode()).decode() if len(rows) > lim else None}
        mm = re.match(r'^/v1/shipments/([^/]+)/events$', p)
        if mm:
            sh = next(s for s in tms['shipments'] if s['shipment_id'] == mm.group(1)); ev = map_events(sh)
            return 200, {'shipmentId': sh['shipment_id'], 'milestone': sh['milestone'], 'count': len(ev), 'results': ev}
        mm = re.match(r'^/v1/shipments/([^/]+)$', p)
        if mm: return 200, map_shp(next(s for s in tms['shipments'] if s['shipment_id'] == mm.group(1)), q.get('include') == 'events')
        if p == '/v1/carriers':
            rows = [c for c in sorted(tms['carriers'], key=lambda c: c['carrier_code']) if (not csv(q, 'code') or c['carrier_code'] in csv(q, 'code')) and (not csv(q, 'scac') or c['scac'] in csv(q, 'scac'))]
            return 200, {'count': len(rows), 'results': [map_carrier(c) for c in rows]}
        mm = re.match(r'^/v1/carriers/([^/]+)$', p)
        if mm:
            c = next(c for c in tms['carriers'] if c['carrier_code'] == mm.group(1) or c['scac'] == mm.group(1))
            by = {}
            for s in tms['shipments']:
                if s['carrier_scac'] == c['scac']: by[s['milestone']] = by.get(s['milestone'], 0) + 1
            return 200, {'carrierCode': c['carrier_code'], 'scac': c['scac'], 'name': c['name'], 'mode': c['mode'], 'trackingUrlTemplate': c['tracking_url_template'], 'shipmentsByMilestone': by}
        if p == '/v1/event-codes': return 200, {'count': len(EVENT_CODES), 'results': [{'code': c, 'description': d, 'resultingMilestone': m} for c, d, m in EVENT_CODES]}
        if p == '/v1/milestones': return 200, {'count': len(MS), 'results': [{'code': k, 'description': v} for k, v in MS.items()]}
    return 404, {'error': f'stub: no route {path}'}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj, ctype='application/json'):
        data = b'' if obj is None else (obj if isinstance(obj, bytes) else json.dumps(obj).encode())
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('ETag', '"r1"'); self.end_headers()
        if data: self.wfile.write(data)
    def handle_any(self, method):
        u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == '/dashboard/config.json':
            return self._send(200, {'mode': 'combined', 'chaosEnabled': True, 'services': [{'name': n, 'title': t, 'baseUrl': f'/{n}', 'authMode': 'apikey', 'apiKeyHeader': 'x-api-key', 'apiKey': f'{n}-demo-key'} for n, t in (('erp', 'ERP Purchasing API (mock)'), ('srm', 'Supplier Master (SRM) API (mock)'), ('tms', 'Logistics / TMS API (mock)'))]})
        if u.path.startswith('/dashboard'):
            rel = u.path[len('/dashboard'):].lstrip('/') or 'index.html'
            f = ROOT / 'public/dashboard' / rel
            if f.is_file():
                ct = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript'}.get(f.suffix, 'application/octet-stream')
                return self._send(200, f.read_bytes(), ct)
            return self._send(404, {'error': 'nf'})
        n = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        try:
            code, obj = route(method, u.path, q, body)
        except StopIteration:
            code, obj = 404, {'error': {'code': 'NOT_FOUND', 'message': 'not found'}}
        self._send(code, obj)
    def do_GET(self): self.handle_any('GET')
    def do_POST(self): self.handle_any('POST')
    def do_PATCH(self): self.handle_any('PATCH')
    def do_DELETE(self): self.handle_any('DELETE')

if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Dashboard stub on http://127.0.0.1:{port}/dashboard/')
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
