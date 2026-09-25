"""Builds postman/mock-po-backends.postman_collection.json and the three environments.

The collection is generated: edit this file, not the JSON.

    python3 tools/build-postman.py          # or: npm run build:postman
    npm run check:postman                   # every OpenAPI operation must have a request

What the generator guarantees (it stops with an error otherwise):
  * every request has a saved example response. GET requests on seed data get theirs rendered by the
    mappers in tools/dashboard-stub.py; everything else passes example=(status, body) explicitly;
  * every request has a description: your desc= text plus the expected status, the variables it
    needs (and which earlier request sets each one), and the variables it saves;
  * a request that needs a variable set by an earlier request checks it before sending and stops with
    a message naming that request, instead of failing with a confusing 404.

When you add an endpoint: add a req() below (usually in create -> read -> change -> delete order,
capturing new IDs with save()), rebuild, and run the coverage check.
"""
import copy, json, re, uuid
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
S = {'__name__': 'lib', '__file__': str(TOOLS / 'dashboard-stub.py')}
exec((TOOLS / 'dashboard-stub.py').read_text(), S)
erp, srm, tms = S['erp'], S['srm'], S['tms']
PO = lambda n: next(p for p in erp['purchase_orders'] if p['po_number'] == n)
SUP = lambda c: next(s for s in srm['suppliers'] if s['supplier_code'] == c)
SHP = lambda i: next(s for s in tms['shipments'] if s['shipment_id'] == i)
CARRIER = lambda code: next(c for c in tms['carriers'] if c['carrier_code'] == code)
OUT = TOOLS.parent / 'postman'
CORR = '5f754b61-2038-4978-a7cb-6d6a97afd501'
NOW_SAP, NOW_ISO = '20260924120000', '2026-09-24T12:00:00.000Z'

# Variables that are infrastructure, not chained IDs (never guarded).
BASE_VARS = {'baseUrl', 'erpUrl', 'srmUrl', 'tmsUrl', 'erpApiKey', 'srmApiKey', 'tmsApiKey', 'runId', 'shipDate', 'etaDate', 'newEta'}

STATUS_TEXT = {200: 'OK', 201: 'Created', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found',
               409: 'Conflict', 412: 'Precondition Failed', 422: 'Unprocessable Entity', 503: 'Service Unavailable'}


def status_test(codes):
    codes = codes if isinstance(codes, (list, tuple)) else [codes]
    return [f"pm.test('Status is {' or '.join(map(str, codes))}', () => pm.expect(pm.response.code).to.be.oneOf({json.dumps(list(codes))}));"]


def url(svc, path, query=None):
    raw = f"{{{{{svc}Url}}}}{path}"
    q = [{"key": k, "value": str(v)} for k, v in (query or {}).items()]
    if q: raw += '?' + '&'.join(f"{x['key']}={x['value']}" for x in q)
    u = {"raw": raw, "host": [f"{{{{{svc}Url}}}}"], "path": [p for p in path.strip('/').split('/') if p]}
    if q: u["query"] = q
    return u


def req(name, method, svc, path, *, body=None, query=None, expect=200, tests=(), pre=(), headers=None, auth=None, desc=None, example=None):
    hdr = [{"key": "Content-Type", "value": "application/json"}] if body is not None else []
    if method == 'POST':
        hdr.append({"key": "Idempotency-Key", "value": "{{$guid}}", "description": "Optional: same key + same body replays the first response"})
    for k, v in (headers or {}).items(): hdr.append({"key": k, "value": v})
    r = {"method": method, "header": hdr, "url": url(svc, path, query)}
    if body is not None: r["body"] = {"mode": "raw", "raw": json.dumps(body, indent=2), "options": {"raw": {"language": "json"}}}
    if auth: r["auth"] = auth
    item = {"name": name, "request": r, "event": [{"listen": "test", "script": {"type": "text/javascript", "exec": status_test(expect) + list(tests)}}]}
    if pre: item["event"].insert(0, {"listen": "prerequest", "script": {"type": "text/javascript", "exec": list(pre)}})
    # build-time metadata, removed before writing
    item["_meta"] = {"svc": svc, "method": method, "path": path, "query": query or {}, "expect": expect, "desc": desc, "example": example}
    return item


def folder(name, items, desc=None, auth=None):
    f = {"name": name, "item": items}
    if desc: f["description"] = desc
    if auth: f["auth"] = auth
    return f


def apikey(var): return {"type": "apikey", "apikey": [{"key": "key", "value": "x-api-key", "type": "string"}, {"key": "value", "value": f"{{{{{var}}}}}", "type": "string"}, {"key": "in", "value": "header", "type": "string"}]}
NOAUTH = {"type": "noauth"}
def badkey(): return {"type": "apikey", "apikey": [{"key": "key", "value": "x-api-key", "type": "string"}, {"key": "value", "value": "wrong-key", "type": "string"}, {"key": "in", "value": "header", "type": "string"}]}
save = lambda var, expr: f"pm.collectionVariables.set('{var}', {expr});"
NEW_RUN = ["pm.collectionVariables.set('runId', String(Date.now()).slice(-6));", "console.log('runId', pm.collectionVariables.get('runId'));"]
erpErr = lambda code, msg, details=None: {"error": {"code": code, "message": msg, "timestamp": NOW_SAP, "correlation_id": CORR, **({"details": details} if details else {})}}
srmErr = lambda code, msg, fields=(): {"errors": [{"code": code, "message": msg}] + [{"code": "FIELD_INVALID", "field": f, "message": m} for f, m in fields], "traceId": CORR}
tmsErr = lambda code, msg, st, detail=None: {"fault": {"faultCode": f"tms.{code}", "faultString": msg, "httpStatus": st, "correlationId": CORR, **({"detail": detail} if detail else {})}}
health = lambda n: {"status": "ok", "service": n, "database": "up", "timestamp": NOW_ISO}
stub = lambda path, q=None: S['route']('GET', path, q or {}, {})[1]

# ═══ ERP ═══════════════════════════════════════════════════════════════
po_body = {"vendor_id": "0000710245", "purch_org": "JBUS", "plant": "1101", "currency": "USD", "delivery_date": "20261215", "buyer_name": "Postman Buyer", "incoterms": "FCA", "payment_terms": "NET60",
           "items": [{"material": "MAT-778210", "short_text": "Industrial controller assembly", "quantity": 100, "uom": "EA", "net_price": 84.5}]}


def item_row(no, material, text, qty, price, conf=0, conf_date=None, shipped=0, reject=None):
    return {"item_no": no, "material": material, "short_text": text, "quantity": f"{qty:.3f}", "uom": "EA", "net_price": f"{price:.2f}", "price_unit": 1,
            "confirmed_qty": f"{conf:.3f}", "confirmed_date": conf_date, "shipped_qty": f"{shipped:.3f}", "open_qty": f"{max(qty - shipped, 0):.3f}", "reject_reason": reject}


base = S['map_po'](PO('4500123456'))  # plant 1101 / JBUS: gives ship_to and purch_org_name


def po_state(number='4500123530', revision=1, status='01', items=None, **hdr):
    o = copy.deepcopy(base)
    o.update(po_number=number, vendor_id='0000710245', doc_date='20260924', delivery_date='20261215', status_code=status, status_text=S['STATUS'][status],
             buyer_name='Postman Buyer', incoterms='FCA', payment_terms='NET60', revision=revision, created_at=NOW_SAP, changed_at=NOW_SAP)
    o.update(hdr)
    o['items'] = items or [item_row('00010', 'MAT-778210', 'Industrial controller assembly', 100, 84.5)]
    return o


i10 = lambda **k: item_row('00010', 'MAT-778210', 'Industrial controller assembly', 100, 84.5, **k)
rev2 = dict(delivery_date='20261220', buyer_name='Postman Buyer 2', incoterms='DAP', payment_terms='NET45')
po_r1 = po_state()
po_r2 = po_state(revision=2, **rev2)
po_r3 = po_state(revision=3, items=[i10(), item_row('00020', 'MAT-778999', 'Spare fuse kit', 50, 1.25)], **rev2)
po_r4 = po_state(revision=4, items=[i10(), item_row('00020', 'MAT-778999', 'Spare fuse kit', 75, 1.10)], **rev2)
po_r5 = po_state(revision=5, **rev2)
po_conf = po_state(revision=5, status='03', items=[i10(conf=100, conf_date='20261220')], **rev2)
po_dlv = po_state(revision=5, status='04', items=[i10(conf=100, conf_date='20261220', shipped=60)], **rev2)
po_cxl = po_state(revision=6, status='09', items=[i10(conf=100, conf_date='20261220')], **rev2)
conf = {"confirmation_no": "7100000101", "po_number": "4500123530", "po_revision": 5, "conf_category": "AB", "conf_category_text": S['CONF_CATEGORIES']['AB'],
        "vendor_reference": "PM-ACK-123456", "note": "Confirmed as ordered.", "status": "POSTED",
        "items": [{"item_no": "00010", "confirmed_qty": "100.000", "confirmed_date": "20261220", "reject_reason": None}], "posted_at": "20260924120510"}
dlv = {"delivery_no": "180000201", "vendor_id": "0000710245", "asn_reference": "ASN-PM-123456", "status": "POSTED", "items": [{"po_number": "4500123530", "item_no": "00010", "quantity": "60.000"}],
       "posted_at": "20260924120700", "reversed_at": None}
page = lambda rows, total=None, limit=25: {"data": rows, "pagination": {"total": total or len(rows), "page": 1, "limit": limit, "totalPages": 1, "hasNext": False, "hasPrev": False}}
pm_org = {"code": "PM123456", "name": "Postman Test Org", "company_code": "PM01"}
pm_plant = {"plant_code": "9123", "site_code": "US-PM-9123", "name": "Postman Test Plant", "street": "1 Demo Way", "city": "Austin", "region": "TX", "postal_code": "78701", "country": "US"}

erp_items = [
    folder('Health & reference data', [
        req('Health (no key needed)', 'GET', 'erp', '/health', auth=NOAUTH, pre=NEW_RUN, example=(200, health('erp')),
            desc='Unauthenticated. Also starts a new runId that keeps the IDs created in this folder unique.'),
        req('Status codes', 'GET', 'erp', '/v1/reference/status-codes', desc='PO header status codes. The façade maps them to OPEN, PARTIALLY_ACKNOWLEDGED, ACKNOWLEDGED, IN_FULFILLMENT, CLOSED, CANCELLED.'),
        req('Confirmation categories', 'GET', 'erp', '/v1/reference/confirmation-categories', desc='AB, AC and RJ correspond to the façade acknowledgementType ACCEPT, ACCEPT_WITH_CHANGES and REJECT.'),
        req('List purchasing orgs', 'GET', 'erp', '/v1/reference/purchasing-orgs', example=(200, {"data": erp['purchasing_orgs']})),
        req('Create purchasing org', 'POST', 'erp', '/v1/reference/purchasing-orgs', expect=201, body={"code": "PM{{runId}}", "name": "Postman Test Org", "company_code": "PM01"},
            tests=[save('orgCode', 'pm.response.json().data.code')], example=(201, {"data": pm_org})),
        req('Get purchasing org', 'GET', 'erp', '/v1/reference/purchasing-orgs/{{orgCode}}', example=(200, {"data": pm_org})),
        req('Change purchasing org', 'PATCH', 'erp', '/v1/reference/purchasing-orgs/{{orgCode}}', body={"name": "Postman Test Org (renamed)"},
            example=(200, {"data": {**pm_org, "name": "Postman Test Org (renamed)"}})),
        req('Delete purchasing org', 'DELETE', 'erp', '/v1/reference/purchasing-orgs/{{orgCode}}', expect=204),
        req('Delete purchasing org in use (409)', 'DELETE', 'erp', '/v1/reference/purchasing-orgs/JBUS', expect=409, example=(409, erpErr('PURCH_ORG_IN_USE', 'Purchasing organisation JBUS is used by 20 purchase order(s)'))),
    ], desc='Code lists and purchasing organisations. Purchase orders already carry purch_org_name, so the façade does not need these at runtime.'),
    folder('Plants', [
        req('List plants', 'GET', 'erp', '/v1/plants', example=(200, {"data": erp['plants'][:3]})),
        req('Find plant by site code', 'GET', 'erp', '/v1/plants', query={"site_code": "US-AUBURN-HILLS"}),
        req('Get plant', 'GET', 'erp', '/v1/plants/1101'),
        req('Create plant', 'POST', 'erp', '/v1/plants', expect=201, pre=["pm.collectionVariables.set('plantCode', String(9000 + Math.floor(Math.random() * 999)));"],
            body={"plant_code": "{{plantCode}}", "site_code": "US-PM-{{plantCode}}", "name": "Postman Test Plant", "street": "1 Demo Way", "city": "Austin", "region": "TX", "postal_code": "78701", "country": "US"},
            example=(201, {"data": pm_plant}), desc='Picks a random plant code 9000-9998 in the pre-request script.'),
        req('Change plant', 'PATCH', 'erp', '/v1/plants/{{plantCode}}', body={"name": "Postman Test Plant (renamed)", "city": "Round Rock"},
            example=(200, {"data": {**pm_plant, "name": "Postman Test Plant (renamed)", "city": "Round Rock"}})),
        req('Delete plant', 'DELETE', 'erp', '/v1/plants/{{plantCode}}', expect=204),
        req('Delete plant in use (409)', 'DELETE', 'erp', '/v1/plants/1101', expect=409, example=(409, erpErr('PLANT_IN_USE', 'Plant 1101 is used by 9 purchase order(s)'))),
    ], desc='Receiving plants. Every purchase order embeds its plant address as ship_to; these endpoints are for maintenance.'),
    folder('Purchase orders', [
        req('List purchase orders', 'GET', 'erp', '/v1/purchase-orders', query={"page": 1, "limit": 10},
            desc='Each entry includes items, ship_to and purch_org_name, so one call gives the façade everything for its list view.'),
        req('List by status and vendor', 'GET', 'erp', '/v1/purchase-orders', query={"status": "01,02,03", "vendor_id": "0000710245"},
            desc='What the façade sends for GET /purchase-orders?supplierId=SUP-100245&status=OPEN,PARTIALLY_ACKNOWLEDGED,ACKNOWLEDGED after mapping the supplier and statuses.'),
        req('List by plant', 'GET', 'erp', '/v1/purchase-orders', query={"plant": "1101", "limit": 5}),
        req('List changed since (delta sync)', 'GET', 'erp', '/v1/purchase-orders', query={"changed_since": "20260920000000"},
            desc='changed_since accepts YYYYMMDDhhmmss or ISO-8601; the façade maps its updatedSince here.'),
        req('Get purchase order (seed)', 'GET', 'erp', '/v1/purchase-orders/4500123458', desc='A seeded PO that is partly shipped (status 04).'),
        req('Create purchase order', 'POST', 'erp', '/v1/purchase-orders', expect=201, body=po_body,
            tests=[save('poNumber', 'pm.response.json().data.po_number'), "pm.test('Status 01 Open', () => pm.expect(pm.response.json().data.status_code).to.eql('01'));"],
            example=(201, {"data": po_r1}), desc='Creates the PO used by the rest of this folder and by Confirmations and Inbound deliveries.'),
        req('Get purchase order', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}', tests=[save('poEtag', "pm.response.headers.get('ETag')")], example=(200, {"data": po_r1})),
        req('Get purchase order - not modified (304)', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}', expect=304, headers={"If-None-Match": "{{poEtag}}"}),
        req('Change header (new revision)', 'PATCH', 'erp', '/v1/purchase-orders/{{poNumber}}', body={"delivery_date": "20261220", "buyer_name": "Postman Buyer 2", "incoterms": "DAP", "payment_terms": "NET45"},
            tests=["pm.test('Revision incremented', () => pm.expect(pm.response.json().data.revision).to.eql(2));"], example=(200, {"data": po_r2}),
            desc='A buyer-side change. It bumps the revision, which lets the supplier confirm again.'),
        req('Add item', 'POST', 'erp', '/v1/purchase-orders/{{poNumber}}/items', expect=201, body={"material": "MAT-778999", "short_text": "Spare fuse kit", "quantity": 50, "uom": "EA", "net_price": 1.25},
            tests=["pm.test('Item 00020 added', () => pm.expect(pm.response.json().data.items.map(i => i.item_no)).to.include('00020'));"], example=(201, {"data": po_r3})),
        req('Change item', 'PATCH', 'erp', '/v1/purchase-orders/{{poNumber}}/items/00020', body={"quantity": 75, "net_price": 1.1}, example=(200, {"data": po_r4})),
        req('List items', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}/items', example=(200, {"data": po_r4['items']})),
        req('Delete item', 'DELETE', 'erp', '/v1/purchase-orders/{{poNumber}}/items/00020', example=(200, {"data": po_r5}), desc='Returns the PO without the item.'),
        req('Delete last item (422)', 'DELETE', 'erp', '/v1/purchase-orders/{{poNumber}}/items/00010', expect=422, example=(422, erpErr('LAST_ITEM', 'A purchase order needs at least one item; delete or cancel the PO instead'))),
    ], desc='Purchase orders with embedded items, ship_to and purch_org_name. Run in order: Create purchase order saves {{poNumber}}.'),
    folder('Confirmations', [
        req('Get current ETag', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}', tests=[save('poEtag', "pm.response.headers.get('ETag')")], example=(200, {"data": po_r5}),
            desc='Saves the ETag for the optional If-Match on the next request.'),
        req('Post confirmation AB (with If-Match)', 'POST', 'erp', '/v1/purchase-orders/{{poNumber}}/confirmations', expect=201, headers={"If-Match": "{{poEtag}}"},
            body={"conf_category": "AB", "vendor_reference": "PM-ACK-{{runId}}", "note": "Confirmed as ordered.", "items": [{"item_no": "00010", "confirmed_qty": 100, "confirmed_date": "20261220"}]},
            tests=[save('confirmationNo', 'pm.response.json().data.confirmation_no'), "pm.test('POSTED', () => pm.expect(pm.response.json().data.status).to.eql('POSTED'));"], example=(201, {"data": conf}),
            desc='The ERP side of the façade acknowledgement. If-Match is optional.'),
        req('Stale If-Match (412)', 'POST', 'erp', '/v1/purchase-orders/{{poNumber}}/confirmations', expect=412, headers={"If-Match": 'W/"{{poNumber}}-r1"'},
            body={"conf_category": "AB", "items": [{"item_no": "00010", "confirmed_qty": 100}]}, example=(412, erpErr('REVISION_MISMATCH', 'PO is at revision 5; If-Match W/"4500123530-r1" is stale'))),
        req('Second confirmation for same revision (409)', 'POST', 'erp', '/v1/purchase-orders/{{poNumber}}/confirmations', expect=409,
            body={"conf_category": "AB", "items": [{"item_no": "00010", "confirmed_qty": 100}]}, example=(409, erpErr('CONFIRMATION_EXISTS', 'Confirmation 7100000101 already exists for revision 5 of PO 4500123530'))),
        req('Confirmations of the PO', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}/confirmations', example=(200, {"data": [conf]})),
        req('Get confirmation', 'GET', 'erp', '/v1/confirmations/{{confirmationNo}}', example=(200, {"data": conf})),
        req('List all confirmations in review', 'GET', 'erp', '/v1/confirmations', query={"status": "IN_REVIEW", "limit": 10}),
        req('List confirmations by vendor and category', 'GET', 'erp', '/v1/confirmations', query={"vendor_id": "0000710245", "conf_category": "AB,AC"}),
    ], desc='Supplier acknowledgements on the PO created in Purchase orders.'),
    folder('Inbound deliveries', [
        req('Over-ship (422)', 'POST', 'erp', '/v1/inbound-deliveries', expect=422, body={"asn_reference": "ASN-PM-OVER-{{runId}}", "vendor_id": "0000710245", "items": [{"po_number": "{{poNumber}}", "item_no": "00010", "quantity": 1000}]},
            example=(422, erpErr('SHIPPED_QUANTITY_EXCEEDS_OPEN_QUANTITY', 'Shipped quantity exceeds the remaining open quantity', [{"field": "items[0].quantity", "message": "4500123530/00010: open 100.000, requested 1000.000"}]))),
        req('Post inbound delivery', 'POST', 'erp', '/v1/inbound-deliveries', expect=201, body={"asn_reference": "ASN-PM-{{runId}}", "vendor_id": "0000710245", "items": [{"po_number": "{{poNumber}}", "item_no": "00010", "quantity": 60}]},
            tests=[save('deliveryNo', 'pm.response.json().data.delivery_no')], example=(201, {"data": dlv}), desc='The ERP step of the ASN saga: reserves shipped quantity against the PO.'),
        req('Get inbound delivery', 'GET', 'erp', '/v1/inbound-deliveries/{{deliveryNo}}', example=(200, {"data": dlv})),
        req('List deliveries for the PO', 'GET', 'erp', '/v1/inbound-deliveries', query={"po_number": "{{poNumber}}"}, example=(200, page([dlv]))),
        req('Find delivery by ASN', 'GET', 'erp', '/v1/inbound-deliveries', query={"asn_reference": "ASN-439901", "vendor_id": "0000710245"}),
        req('PO is now in delivery (04)', 'GET', 'erp', '/v1/purchase-orders/{{poNumber}}', tests=["pm.test('Status 04', () => pm.expect(pm.response.json().data.status_code).to.eql('04'));"], example=(200, {"data": po_dlv})),
        req('Reverse inbound delivery (compensation)', 'POST', 'erp', '/v1/inbound-deliveries/{{deliveryNo}}/reverse', body={"reason": "Postman compensation test"},
            tests=["pm.test('REVERSED', () => pm.expect(pm.response.json().data.status).to.eql('REVERSED'));"], example=(200, {"data": {**dlv, "status": "REVERSED", "reversed_at": "20260924120900"}}),
            desc='Releases the reserved quantity. Available for an ERP-first saga; the default saga compensates in TMS instead.'),
        req('Reverse again (409)', 'POST', 'erp', '/v1/inbound-deliveries/{{deliveryNo}}/reverse', expect=409, body={}, example=(409, erpErr('DELIVERY_ALREADY_REVERSED', 'Inbound delivery 180000201 was already reversed'))),
    ], desc='The ERP side of an ASN, on the PO created in Purchase orders.'),
    folder('Close, cancel & delete', [
        req('Delete PO with follow-on documents (409)', 'DELETE', 'erp', '/v1/purchase-orders/{{poNumber}}', expect=409, example=(409, erpErr('PO_HAS_FOLLOW_ON_DOCUMENTS', 'PO 4500123530 has 1 confirmation(s) and 1 inbound deliverie(s); cancel it instead (PATCH status_code 09)'))),
        req('Cancel purchase order (09)', 'PATCH', 'erp', '/v1/purchase-orders/{{poNumber}}', body={"status_code": "09"}, tests=["pm.test('Cancelled', () => pm.expect(pm.response.json().data.status_code).to.eql('09'));"], example=(200, {"data": po_cxl})),
        req('Change a cancelled PO (409)', 'PATCH', 'erp', '/v1/purchase-orders/{{poNumber}}', expect=409, body={"buyer_name": "Too late"}, example=(409, erpErr('PO_LOCKED', 'Purchase order is cancelled and cannot be changed'))),
        req('Create throwaway PO', 'POST', 'erp', '/v1/purchase-orders', expect=201, body=po_body, tests=[save('tempPoNumber', 'pm.response.json().data.po_number')], example=(201, {"data": po_state('4500123531')})),
        req('Delete throwaway PO', 'DELETE', 'erp', '/v1/purchase-orders/{{tempPoNumber}}', expect=204, desc='A PO without confirmations or deliveries can be deleted.'),
    ]),
    folder('Errors & security', [
        req('Missing API key (401)', 'GET', 'erp', '/v1/purchase-orders', expect=401, auth=NOAUTH, example=(401, erpErr('API_KEY_MISSING', "Missing API key. Supply it in the 'x-api-key' header."))),
        req('Wrong API key (401)', 'GET', 'erp', '/v1/purchase-orders', expect=401, auth=badkey(), example=(401, erpErr('API_KEY_INVALID', 'The supplied API key is not valid for this service.'))),
        req('Unknown PO (404)', 'GET', 'erp', '/v1/purchase-orders/4599999999', expect=404, example=(404, erpErr('PO_NOT_FOUND', 'Purchase order 4599999999 does not exist'))),
        req('Façade PO id sent to ERP (400)', 'GET', 'erp', '/v1/purchase-orders/PO-4500123456', expect=400,
            example=(400, erpErr('INVALID_PO_NUMBER', 'ERP purchase order numbers are exactly 10 digits (no prefix)', [{"field": "po_number", "message": "must match ^[0-9]{10}$"}])),
            desc='The ERP rejects the PO- prefix: the façade must strip it.'),
        req('Validation errors (400)', 'POST', 'erp', '/v1/purchase-orders', expect=400, body={"vendor_id": "710245", "items": []},
            example=(400, erpErr('VALIDATION_FAILED', 'Request validation failed', [{"field": "vendor_id", "message": "must match pattern /^[0-9]{10}$/"}, {"field": "purch_org", "message": "is required"},
                                                                                     {"field": "currency", "message": "is required"}, {"field": "delivery_date", "message": "is required"},
                                                                                     {"field": "plant", "message": "is required"}, {"field": "items", "message": "must contain at least 1 item(s)"}]))),
        req('Simulated outage (503 via x-mock-status)', 'GET', 'erp', '/v1/purchase-orders', expect=503, headers={"x-mock-status": "503"},
            tests=["pm.test('Retry-After present', () => pm.expect(pm.response.headers.has('Retry-After')).to.be.true);"],
            example=(503, erpErr('SIMULATED_FAILURE', 'Simulated 503 requested via x-mock-status header')), desc='Needs CHAOS_ENABLED=true (the default).'),
        req('Slow legacy ERP (x-mock-delay-ms)', 'GET', 'erp', '/v1/purchase-orders/4500123456', headers={"x-mock-delay-ms": "1500"},
            tests=["pm.test('Took at least 1.4 s', () => pm.expect(pm.response.responseTime).to.be.above(1400));"], desc='Adds 1.5 s of latency. Needs CHAOS_ENABLED=true.'),
    ]),
]

# ═══ SRM ═══════════════════════════════════════════════════════════════
newSup = {**S['map_sup'](SUP('SUP-100812'), True), "supplierCode": "SUP-100997", "erpVendorNumber": "0009123456", "name": {"legal": "Postman Components LLC", "trading": "Postman Components"},
          "status": "ACTIVE", "statusReason": None, "classification": {"tier": "APPROVED", "riskRating": "LOW"}, "capabilities": {"portal": True, "asn": True},
          "countryCode": "US", "duns": "123456789", "onboardedOn": None, "updatedAt": NOW_ISO, "contacts": [], "sites": []}
site = {"siteCode": "SUP-PM-123456", "supplierCode": "SUP-100997", "type": "SHIP_FROM", "name": "Postman DC", "address": {"line1": "1 Demo Way", "city": "Austin", "region": "TX", "postalCode": "78701", "countryCode": "US"}, "active": True}
contact = {"contactId": "CNT-0059", "role": "PRIMARY", "name": "Pat Postman", "email": "pat@postman-components.example.com", "phone": "+1-512-555-0100", "supplierCode": "SUP-100997"}
supChanged = {**newSup, "name": {"legal": "Postman Components LLC", "trading": "PM Components"}, "classification": {"tier": "PREFERRED", "riskRating": "LOW"}, "onboardedOn": "2026-09-24",
              "sites": [site], "contacts": [{k: v for k, v in contact.items() if k != 'supplierCode'}]}
ent = {"consumerId": "pm-consumer-123456", "displayName": "Postman Test Consumer", "consumerType": "supplier-partner", "allSuppliers": False, "suppliers": ["SUP-100997"],
       "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "costCenter": "EXT-PM", "contactEmail": "it@postman-components.example.com", "updatedAt": NOW_ISO}
pm_sup_ref = {"supplierCode": "SUP-100997", "erpVendorNumber": "0009123456"}


def decision(allowed, reason, scope='supplier-orders.write', status='ACTIVE', supplier='SUP-100997', vendors=(pm_sup_ref,), allowed_sups=('SUP-100997',)):
    sup = {"supplierCode": "SUP-100997", "erpVendorNumber": "0009123456", "legalName": "Postman Components LLC", "status": status, "asnEnabled": True} if supplier == 'SUP-100997' else \
        {"supplierCode": supplier, "erpVendorNumber": SUP(supplier)['erp_vendor_number'], "legalName": SUP(supplier)['legal_name'], "status": SUP(supplier)['status'], "asnEnabled": SUP(supplier)['asn_enabled']}
    return {"consumerId": "pm-consumer-123456", "consumerType": "supplier-partner", "scope": scope, "supplierCode": supplier, "allowed": allowed, "reason": reason, "supplier": sup,
            "allowedSuppliers": list(allowed_sups), "allowedVendors": list(vendors), "evaluatedAt": NOW_ISO}


srm_items = [
    folder('Suppliers', [
        req('Health (no key needed)', 'GET', 'srm', '/health', auth=NOAUTH, pre=NEW_RUN, example=(200, health('srm')), desc='Unauthenticated. Also starts a new runId for this folder.'),
        req('List suppliers', 'GET', 'srm', '/v1/suppliers', query={"offset": 0, "limit": 5}),
        req('Search suppliers (status, tier, country, name)', 'GET', 'srm', '/v1/suppliers', query={"status": "ACTIVE", "tier": "STRATEGIC,PREFERRED", "country": "US,DE", "q": "a"}),
        req('List with sites and contacts (expand)', 'GET', 'srm', '/v1/suppliers', query={"expand": "sites,contacts", "limit": 3}),
        req('Get supplier', 'GET', 'srm', '/v1/suppliers/SUP-100245', example=(200, S['map_sup'](SUP('SUP-100245'), True))),
        req('Create supplier', 'POST', 'srm', '/v1/suppliers', expect=201,
            body={"erpVendorNumber": "0009{{runId}}", "name": {"legal": "Postman Components LLC", "trading": "Postman Components"}, "countryCode": "US", "classification": {"tier": "APPROVED", "riskRating": "LOW"}, "capabilities": {"portal": True, "asn": True}, "duns": "123456789"},
            tests=[save('supplierCode', 'pm.response.json().supplierCode'), save('vendorNumber', 'pm.response.json().erpVendorNumber')], example=(201, newSup),
            desc='supplierCode is optional; SRM assigns the next SUP- number.'),
        req('Change master data', 'PATCH', 'srm', '/v1/suppliers/{{supplierCode}}', body={"name": {"trading": "PM Components"}, "classification": {"tier": "PREFERRED"}, "onboardedOn": "2026-09-24"},
            example=(200, {**newSup, "name": {"legal": "Postman Components LLC", "trading": "PM Components"}, "classification": {"tier": "PREFERRED", "riskRating": "LOW"}, "onboardedOn": "2026-09-24"})),
    ], desc='Supplier master. Run in order: Create supplier saves {{supplierCode}} and {{vendorNumber}}.'),
    folder('Sites & contacts', [
        req('Add site', 'POST', 'srm', '/v1/suppliers/{{supplierCode}}/sites', expect=201,
            body={"siteCode": "SUP-PM-{{runId}}", "type": "SHIP_FROM", "name": "Postman DC", "address": {"line1": "1 Demo Way", "city": "Austin", "region": "TX", "postalCode": "78701", "countryCode": "US"}},
            tests=[save('siteCode', 'pm.response.json().siteCode')], example=(201, site)),
        req('Sites of supplier', 'GET', 'srm', '/v1/suppliers/{{supplierCode}}/sites', query={"type": "SHIP_FROM", "active": "true"}, example=(200, {"total": 1, "items": [site]})),
        req('List all sites', 'GET', 'srm', '/v1/sites', query={"type": "SHIP_FROM", "country": "US", "limit": 10}),
        req('Get site', 'GET', 'srm', '/v1/sites/{{siteCode}}', example=(200, site)),
        req('Change site', 'PATCH', 'srm', '/v1/sites/{{siteCode}}', body={"name": "Postman DC (Austin)", "address": {"postalCode": "78702", "countryCode": "US"}},
            example=(200, {**site, "name": "Postman DC (Austin)", "address": {**site['address'], "postalCode": "78702"}})),
        req('Add contact', 'POST', 'srm', '/v1/suppliers/{{supplierCode}}/contacts', expect=201,
            body={"role": "PRIMARY", "name": "Pat Postman", "email": "pat@postman-components.example.com", "phone": "+1-512-555-0100"},
            tests=[save('contactId', 'pm.response.json().contactId')], example=(201, contact)),
        req('Contacts of supplier', 'GET', 'srm', '/v1/suppliers/{{supplierCode}}/contacts', query={"role": "PRIMARY"}, example=(200, {"total": 1, "items": [{k: v for k, v in contact.items() if k != 'supplierCode'}]})),
        req('List all contacts', 'GET', 'srm', '/v1/contacts', query={"role": "LOGISTICS", "limit": 10}),
        req('Get contact', 'GET', 'srm', '/v1/contacts/{{contactId}}', example=(200, contact)),
        req('Change contact', 'PATCH', 'srm', '/v1/contacts/{{contactId}}', body={"role": "LOGISTICS", "phone": "+1-512-555-0199"}, example=(200, {**contact, "role": "LOGISTICS", "phone": "+1-512-555-0199"})),
    ], desc='Ship-from sites and contacts of the supplier created in Suppliers.'),
    folder('ERP vendor cross-reference', [
        req('Batch resolve ERP vendors', 'GET', 'srm', '/v1/vendor-xref', query={"erpVendorNumber": "0000710245,0000710311,0000799999"},
            example=(200, {"items": [{"supplierCode": s, "erpVendorNumber": SUP(s)['erp_vendor_number'], "status": SUP(s)['status'], "legalName": SUP(s)['legal_name']} for s in ("SUP-100245", "SUP-100311")], "unresolved": ["0000799999"]}),
            desc='Ad-hoc lookups. The façade does not need this: the entitlement check already returns the vendor numbers.'),
        req('Resolve one vendor', 'GET', 'srm', '/v1/vendor-xref/{{vendorNumber}}', example=(200, {"supplierCode": "SUP-100997", "erpVendorNumber": "0009123456", "status": "ACTIVE", "legalName": "Postman Components LLC"})),
        req('Unmapped vendor (404)', 'GET', 'srm', '/v1/vendor-xref/0000799999', expect=404, example=(404, srmErr('VENDOR_NOT_MAPPED', 'ERP vendor 0000799999 has no supplier master record'))),
    ]),
    folder('Entitlements', [
        req('List entitlements', 'GET', 'srm', '/v1/entitlements', query={"active": "true"}, example=(200, {"total": 2, "items": [S['map_ent'](e) for e in srm['entitlements'][:2]]})),
        req('Create entitlement', 'POST', 'srm', '/v1/entitlements', expect=201,
            body={"consumerId": "pm-consumer-{{runId}}", "displayName": "Postman Test Consumer", "consumerType": "supplier-partner", "scopes": ["supplier-orders.read", "supplier-orders.write"], "suppliers": ["{{supplierCode}}"], "costCenter": "EXT-PM", "contactEmail": "it@postman-components.example.com"},
            tests=[save('consumerId', 'pm.response.json().consumerId')], example=(201, ent)),
        req('Get entitlement', 'GET', 'srm', '/v1/entitlements/{{consumerId}}', example=(200, ent)),
        req('Check write access (allowed)', 'GET', 'srm', '/v1/entitlements/{{consumerId}}/check', query={"scope": "supplier-orders.write", "supplierCode": "{{supplierCode}}"},
            tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);", "pm.test('Returns the ERP vendor', () => pm.expect(pm.response.json().supplier.erpVendorNumber).to.eql(pm.collectionVariables.get('vendorNumber')));"],
            example=(200, decision(True, 'OK')), desc='The one SRM call per façade request: the decision plus supplier.erpVendorNumber and allowedVendors.'),
        req('Check by ERP vendor number', 'GET', 'srm', '/v1/entitlements/{{consumerId}}/check', query={"scope": "supplier-orders.read", "erpVendorNumber": "{{vendorNumber}}"},
            tests=["pm.test('Resolved to the supplier code', () => pm.expect(pm.response.json().supplierCode).to.eql(pm.collectionVariables.get('supplierCode')));"],
            example=(200, decision(True, 'OK', scope='supplier-orders.read')), desc='Use this form when you start from an ERP purchase order: pass its vendor_id and read supplierCode from the answer.'),
        req('Put supplier on hold', 'PATCH', 'srm', '/v1/suppliers/{{supplierCode}}', body={"status": "ON_HOLD", "statusReason": "Postman governance test"},
            example=(200, {**supChanged, "status": "ON_HOLD", "statusReason": "Postman governance test"})),
        req('Check write access (denied: on hold)', 'POST', 'srm', '/v1/entitlements/{{consumerId}}/check', body={"scope": "supplier-orders.write", "supplierCode": "{{supplierCode}}"},
            tests=["pm.test('Denied with SUPPLIER_ON_HOLD', () => { const r = pm.response.json(); pm.expect(r.allowed).to.be.false; pm.expect(r.reason).to.eql('SUPPLIER_ON_HOLD'); });"],
            example=(200, decision(False, 'SUPPLIER_ON_HOLD', status='ON_HOLD')), desc='Same decision in POST form. The façade turns allowed=false into a 403.'),
        req('Reactivate supplier', 'PATCH', 'srm', '/v1/suppliers/{{supplierCode}}', body={"status": "ACTIVE"}, example=(200, {**supChanged, "status": "ACTIVE", "statusReason": None})),
        req('Check other supplier (denied: scope)', 'GET', 'srm', '/v1/entitlements/{{consumerId}}/check', query={"scope": "supplier-orders.read", "supplierCode": "SUP-100245"},
            tests=["pm.test('SUPPLIER_SCOPE_DENIED', () => pm.expect(pm.response.json().reason).to.eql('SUPPLIER_SCOPE_DENIED'));"],
            example=(200, decision(False, 'SUPPLIER_SCOPE_DENIED', scope='supplier-orders.read', supplier='SUP-100245'))),
        req('Grant a second supplier', 'PATCH', 'srm', '/v1/entitlements/{{consumerId}}', body={"suppliers": ["{{supplierCode}}", "SUP-100245"], "scopes": ["supplier-orders.read"]},
            example=(200, {**ent, "suppliers": ["SUP-100997", "SUP-100245"], "scopes": ["supplier-orders.read"]})),
        req('Delete supplier referenced by entitlement (409)', 'DELETE', 'srm', '/v1/suppliers/{{supplierCode}}', expect=409,
            example=(409, srmErr('SUPPLIER_HAS_ENTITLEMENTS', 'Supplier is referenced by consumer entitlement(s): pm-consumer-123456. Remove it from those first.'))),
        req('Delete entitlement', 'DELETE', 'srm', '/v1/entitlements/{{consumerId}}', expect=204),
        req('Check unknown consumer (404)', 'GET', 'srm', '/v1/entitlements/{{consumerId}}/check', query={"scope": "supplier-orders.read"}, expect=404,
            example=(404, srmErr('CONSUMER_NOT_FOUND', 'Consumer pm-consumer-123456 is not registered')), desc='The only case where the check does not answer 200.'),
    ], desc='Consumer entitlements and the check endpoint, using the supplier created in Suppliers.'),
    folder('Clean up', [
        req('Delete contact', 'DELETE', 'srm', '/v1/contacts/{{contactId}}', expect=204),
        req('Delete site', 'DELETE', 'srm', '/v1/sites/{{siteCode}}', expect=204),
        req('Delete supplier', 'DELETE', 'srm', '/v1/suppliers/{{supplierCode}}', expect=204),
        req('Deleted supplier is gone (404)', 'GET', 'srm', '/v1/suppliers/{{supplierCode}}', expect=404, example=(404, srmErr('SUPPLIER_NOT_FOUND', 'Supplier SUP-100997 does not exist'))),
    ], desc='Removes everything the SRM folder created.'),
    folder('Errors & security', [
        req('Missing API key (401)', 'GET', 'srm', '/v1/suppliers', expect=401, auth=NOAUTH, example=(401, srmErr('API_KEY_MISSING', "Missing API key. Supply it in the 'x-api-key' header."))),
        req('Bad supplier code (400)', 'GET', 'srm', '/v1/suppliers/100245', expect=400,
            example=(400, srmErr('INVALID_SUPPLIER_CODE', 'Supplier codes look like SUP-000000', [("supplierCode", "must match ^SUP-[0-9]{6}$")]))),
        req('Invalid filter (400)', 'GET', 'srm', '/v1/suppliers', query={"status": "SUSPENDED"}, expect=400,
            example=(400, srmErr('INVALID_FILTER', 'status must be one of ACTIVE, ON_HOLD, BLOCKED', [("status", "invalid value")]))),
    ]),
]

# ═══ TMS ═══════════════════════════════════════════════════════════════
origin = {"locationCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "street": "4500 Fulton Industrial Blvd SW", "city": "Atlanta", "state": "GA", "zip": "30301", "country": "US"}
dest = {"locationCode": "US-AUBURN-HILLS", "name": erp['plants'][0]['name'], "street": "100 Manufacturing Way", "city": "Auburn Hills", "state": "MI", "zip": "48326", "country": "US"}
shp_body = {"asnNumber": "ASN-PM-{{runId}}", "supplierCode": "SUP-100245", "carrier": {"carrierCode": "UPS", "trackingId": "1Z999AA1{{runId}}0001"},
            "route": {"origin": origin, "destination": dest},
            "schedule": {"plannedShipDate": "{{shipDate}}", "estimatedArrival": "{{etaDate}}"},
            "contents": [{"poNumber": "4500123456", "poLine": 10, "quantity": {"value": 50, "uom": "EA"}, "lotNumber": "LOT-PM-{{runId}}"}],
            "handlingUnits": [{"huId": "PALLET-PM-{{runId}}", "type": "PLT", "weight": {"value": 120, "unit": "kg"}}], "tender": False}
MSD = S['MS']


def shipment(shipment_id='SHP-20260924-00200', asn='ASN-PM-123456', milestone='PLN', carrier='UPS', tracking='1Z999AA11234560001', eta='2026-09-30T12:00:00Z',
             hu_weight=120, contents=None, events=None, cancel=None):
    c = CARRIER(carrier)
    o = {"shipmentId": shipment_id, "asnNumber": asn, "supplierCode": "SUP-100245",
         "carrier": {"scac": c['scac'], "carrierCode": c['carrier_code'], "name": c['name'], "trackingId": tracking,
                     "trackingUrl": c['tracking_url_template'].replace('{trackingId}', tracking) if c.get('tracking_url_template') and tracking else None},
         "milestone": {"code": milestone, "description": MSD[milestone], "since": NOW_ISO}, "route": {"origin": origin, "destination": dest},
         "schedule": {"plannedShipDate": "2026-09-26T12:00:00.000Z", "estimatedArrival": eta.replace('Z', '.000Z') if not eta.endswith('.000Z') else eta},
         "contents": contents or [{"poNumber": "4500123456", "poLine": 10, "quantity": {"value": 50, "uom": "EA"}, "lotNumber": "LOT-PM-123456"}],
         "handlingUnits": [{"huId": "PALLET-PM-123456", "type": "PLT", "weight": {"value": hu_weight, "unit": "kg"}}], "cancelReason": cancel,
         "audit": {"createdAt": NOW_ISO, "updatedAt": NOW_ISO}}
    if events is not None:
        o['events'] = [{"eventId": 2000 + n, "code": code, "description": d, "location": loc, "occurredAt": NOW_ISO, "recordedAt": NOW_ISO} for n, (code, d, loc) in enumerate(events)]
    return o


EV_TND = ('TND', 'ASN received and tendered to carrier', None)
EV_PU = ('PU', 'Picked up by carrier', 'Atlanta, GA, US')
EV_EXC = ('EXC', 'Weather delay at hub', 'Louisville, KY, US')
EV_RES = ('RES', 'Exception resolved - movement resumed', 'Louisville, KY, US')
EV_DLV = ('DLV', 'Delivered', 'Auburn Hills, MI, US')
shp_pln = shipment()
shp_changed = shipment(carrier='FEDEX', eta='2026-10-02T12:00:00Z', hu_weight=135)
fdx = dict(carrier='FEDEX', eta='2026-10-02T12:00:00Z', hu_weight=135)
shp_tnd = shipment(milestone='TND', **fdx)
shp_pu = shipment(milestone='ITR', events=[EV_TND, EV_PU], **fdx)
shp_trk = shipment(milestone='ITR', tracking='7712123456 01'.replace(' ', ''), **{k: v for k, v in fdx.items()})
fdx_t = {**fdx}
shp_exc = shipment(milestone='EXC', tracking='771212345601', events=[EV_TND, EV_PU, EV_EXC], **fdx_t)
shp_res = shipment(milestone='ITR', tracking='771212345601', events=[EV_TND, EV_PU, EV_EXC, EV_RES], **fdx_t)
shp_dlv = shipment(milestone='DLV', tracking='771212345601', events=[EV_TND, EV_PU, EV_EXC, EV_RES, EV_DLV], **fdx_t)
first_page = stub('/tms/v1/shipments', {'limit': '5'})
second_page = stub('/tms/v1/shipments', {'limit': '5', 'cursor': first_page['nextCursor']})
pm_carrier = {"carrierCode": "PM123456", "scac": "QXYZ", "name": "Postman Freight", "mode": "LTL", "trackingUrlTemplate": "https://track.example.com/{trackingId}"}

tms_items = [
    folder('Reference data & carriers', [
        req('Health (no key needed)', 'GET', 'tms', '/health', auth=NOAUTH, pre=NEW_RUN + ["const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let s = 'Q'; for (let i = 0; i < 3; i++) s += L[Math.floor(Math.random() * 26)]; pm.collectionVariables.set('newScac', s);"],
            example=(200, health('tms')), desc='Unauthenticated. Starts a new runId and picks a random SCAC for Create carrier.'),
        req('Milestones', 'GET', 'tms', '/v1/milestones', desc='Milestones map to the façade shipment status: PLN DRAFT, TND SUBMITTED, ITR IN_TRANSIT, DLV DELIVERED, EXC DELAYED, CXL CANCELLED.'),
        req('Event codes', 'GET', 'tms', '/v1/event-codes'),
        req('List carriers', 'GET', 'tms', '/v1/carriers'),
        req('Find carriers by code', 'GET', 'tms', '/v1/carriers', query={"code": "UPS,DHL"}, desc='Optional: shipments accept carrier.carrierCode directly, so the façade does not need this lookup.'),
        req('Get carrier (with shipment counts)', 'GET', 'tms', '/v1/carriers/UPS', example=(200, {**S['map_carrier'](CARRIER('UPS')), "shipmentsByMilestone": {"DLV": 3, "ITR": 1}})),
        req('Create carrier', 'POST', 'tms', '/v1/carriers', expect=201, body={"carrierCode": "PM{{runId}}", "scac": "{{newScac}}", "name": "Postman Freight", "mode": "LTL", "trackingUrlTemplate": "https://track.example.com/{trackingId}"},
            tests=[save('carrierCode', 'pm.response.json().carrierCode')], example=(201, pm_carrier)),
        req('Change carrier', 'PATCH', 'tms', '/v1/carriers/{{carrierCode}}', body={"name": "Postman Freight Lines", "mode": "FTL"}, example=(200, {**pm_carrier, "name": "Postman Freight Lines", "mode": "FTL"})),
        req('Delete carrier', 'DELETE', 'tms', '/v1/carriers/{{carrierCode}}', expect=204),
        req('Delete carrier in use (409)', 'DELETE', 'tms', '/v1/carriers/UPS', expect=409, example=(409, tmsErr('CARRIER_IN_USE', 'Carrier UPS (UPSN) is used by 6 shipment(s)', 409))),
    ], desc='Milestones, event codes and the carrier master (business code and SCAC).'),
    folder('Shipments', [
        req('List shipments', 'GET', 'tms', '/v1/shipments', query={"limit": 5}),
        req('Filter by milestone and carrier', 'GET', 'tms', '/v1/shipments', query={"status": "ITR,EXC", "carrier": "DHL"}, desc='carrier accepts a SCAC or a carrier code.'),
        req('Find by PO number', 'GET', 'tms', '/v1/shipments', query={"poNumber": "4500123458"}),
        req('Find by supplier and ASN', 'GET', 'tms', '/v1/shipments', query={"supplierCode": "SUP-100245", "asnNumber": "ASN-439901"}),
        req('First page (saves nextCursor)', 'GET', 'tms', '/v1/shipments', query={"limit": 5}, tests=["const c = pm.response.json().nextCursor; if (c) pm.collectionVariables.set('cursor', c);"], example=(200, first_page)),
        req('Next page (cursor)', 'GET', 'tms', '/v1/shipments', query={"limit": 5, "cursor": "{{cursor}}"}, example=(200, second_page), desc='The façade passes pageToken straight through as cursor.'),
        req('Get shipment with events', 'GET', 'tms', '/v1/shipments/SHP-20260918-00121', query={"include": "events"}, example=(200, S['map_shp'](SHP('SHP-20260918-00121'), True))),
        req('Create shipment (planned)', 'POST', 'tms', '/v1/shipments', expect=201, body=shp_body,
            tests=[save('shipmentId', 'pm.response.json().shipmentId'), "pm.test('PLN', () => pm.expect(pm.response.json().milestone.code).to.eql('PLN'));",
                   "pm.test('carrierCode UPS resolved to SCAC UPSN', () => pm.expect(pm.response.json().carrier.scac).to.eql('UPSN'));"],
            example=(201, shp_pln), desc='Sends the façade carrier code (UPS); TMS resolves the SCAC. tender:false creates it as PLN (façade DRAFT).'),
        req('Duplicate ASN for supplier (409)', 'POST', 'tms', '/v1/shipments', expect=409, body=shp_body,
            example=(409, tmsErr('DUPLICATE_ASN', 'ASN ASN-PM-123456 already exists for SUP-100245 as SHP-20260924-00200', 409))),
        req('Change planned shipment', 'PATCH', 'tms', '/v1/shipments/{{shipmentId}}', body={"carrier": {"scac": "FDEG"}, "schedule": {"estimatedArrival": "{{newEta}}"}, "handlingUnits": [{"huId": "PALLET-PM-{{runId}}", "type": "PLT", "weight": {"value": 135, "unit": "kg"}}]},
            example=(200, shp_changed), desc='Carrier by SCAC this time; carrierCode works too.'),
        req('Event before tender (409)', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/events', expect=409, body={"eventCode": "PU"},
            example=(409, tmsErr('NOT_TENDERED', 'Shipment is still planned; tender it before posting tracking events', 409))),
        req('Tender to carrier', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/tender', tests=["pm.test('TND', () => pm.expect(pm.response.json().milestone.code).to.eql('TND'));"], example=(200, shp_tnd)),
        req('Event PU picked up', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/events', expect=201, body={"eventCode": "PU", "location": "Atlanta, GA, US"}, example=(201, shp_pu)),
        req('Change carrier after pickup (409)', 'PATCH', 'tms', '/v1/shipments/{{shipmentId}}', expect=409, body={"carrier": {"scac": "UPSN"}},
            example=(409, tmsErr('FIELD_LOCKED', 'Shipment is in transit; these fields can no longer change: carrier.scac, route, schedule.plannedShipDate, handlingUnits', 409))),
        req('Update tracking ID in transit', 'PATCH', 'tms', '/v1/shipments/{{shipmentId}}', body={"carrier": {"trackingId": "7712{{runId}}01"}}, example=(200, shp_trk)),
        req('Event EXC with new ETA', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/events', expect=201, body={"eventCode": "EXC", "description": "Weather delay at hub", "location": "Louisville, KY, US", "newEstimatedArrival": "{{newEta}}"},
            tests=["pm.test('EXC', () => pm.expect(pm.response.json().milestone.code).to.eql('EXC'));"], example=(201, shp_exc), desc='The façade shows this shipment as DELAYED with the new expectedArrivalAt.'),
        req('Event RES resumed', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/events', expect=201, body={"eventCode": "RES", "location": "Louisville, KY, US"}, example=(201, shp_res)),
        req('Event DLV delivered', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/events', expect=201, body={"eventCode": "DLV", "location": "Auburn Hills, MI, US"},
            tests=["pm.test('DLV', () => pm.expect(pm.response.json().milestone.code).to.eql('DLV'));"], example=(201, shp_dlv)),
        req('Tracking events', 'GET', 'tms', '/v1/shipments/{{shipmentId}}/events', example=(200, {"shipmentId": "SHP-20260924-00200", "milestone": "DLV", "count": 5, "results": shp_dlv['events']})),
        req('Cancel delivered shipment (409)', 'POST', 'tms', '/v1/shipments/{{shipmentId}}/cancel', expect=409, body={"reason": "too late"},
            example=(409, tmsErr('SHIPMENT_CLOSED', 'Shipment is delivered and cannot be cancelled', 409))),
    ], desc='A shipment from creation to delivery. Run in order: Create shipment (planned) saves {{shipmentId}}.'),
    folder('Cancel & delete', [
        req('Create tendered shipment', 'POST', 'tms', '/v1/shipments', expect=201, body={**shp_body, "asnNumber": "ASN-PM-{{runId}}-B", "tender": True}, tests=[save('shipmentId2', 'pm.response.json().shipmentId')],
            example=(201, shipment('SHP-20260924-00201', 'ASN-PM-123456-B', 'TND'))),
        req('Cancel shipment (compensation)', 'POST', 'tms', '/v1/shipments/{{shipmentId2}}/cancel', body={"reason": "ERP inbound delivery failed"},
            tests=["pm.test('CXL', () => pm.expect(pm.response.json().milestone.code).to.eql('CXL'));"],
            example=(200, shipment('SHP-20260924-00201', 'ASN-PM-123456-B', 'CXL', cancel='ERP inbound delivery failed')), desc='The compensation step of the ASN saga. It frees the ASN number for a retry.'),
        req('Delete non-draft shipment (409)', 'DELETE', 'tms', '/v1/shipments/{{shipmentId2}}', expect=409,
            example=(409, tmsErr('SHIPMENT_NOT_DRAFT', 'Only planned (PLN) shipments can be deleted; this one is CXL. Use POST /cancel instead.', 409))),
        req('Create draft shipment', 'POST', 'tms', '/v1/shipments', expect=201, body={**shp_body, "asnNumber": "ASN-PM-{{runId}}-C"}, tests=[save('shipmentId3', 'pm.response.json().shipmentId')],
            example=(201, shipment('SHP-20260924-00202', 'ASN-PM-123456-C'))),
        req('Delete draft shipment', 'DELETE', 'tms', '/v1/shipments/{{shipmentId3}}', expect=204),
    ]),
    folder('Errors & security', [
        req('Missing API key (401)', 'GET', 'tms', '/v1/shipments', expect=401, auth=NOAUTH, example=(401, tmsErr('API_KEY_MISSING', "Missing API key. Supply it in the 'x-api-key' header.", 401))),
        req('Unknown shipment (404)', 'GET', 'tms', '/v1/shipments/SHP-20990101-99999', expect=404, example=(404, tmsErr('SHIPMENT_NOT_FOUND', 'Shipment SHP-20990101-99999 does not exist', 404))),
        req('Unknown carrier code (422)', 'POST', 'tms', '/v1/shipments', expect=422, body={**shp_body, "asnNumber": "ASN-PM-{{runId}}-X", "carrier": {"carrierCode": "ACME"}},
            example=(422, tmsErr('UNKNOWN_CARRIER', 'Carrier ACME is not configured in TMS (see GET /tms/v1/carriers)', 422, [{"path": "carrier.carrierCode", "issue": "unknown carrier code"}]))),
        req('ETA before ship date (422)', 'POST', 'tms', '/v1/shipments', expect=422, body={**shp_body, "asnNumber": "ASN-PM-{{runId}}-Y", "schedule": {"plannedShipDate": "{{etaDate}}", "estimatedArrival": "{{shipDate}}"}},
            example=(422, tmsErr('INVALID_SCHEDULE', 'estimatedArrival must not be before plannedShipDate', 422, [{"path": "schedule.estimatedArrival", "issue": "must be >= schedule.plannedShipDate"}]))),
    ]),
]

# ═══ Scenarios: exactly the calls the façade makes (see docs/MAPPING.md) ═══════════════
SC_ERP, SC_SRM, SC_TMS = apikey('erpApiKey'), apikey('srmApiKey'), apikey('tmsApiKey')
def a(item, auth): item['request']['auth'] = auth; return item
chk = lambda consumer, **q: S['check'](consumer, q)
po58 = S['map_po'](PO('4500123458'))
apex_vendors = [x['erpVendorNumber'] for x in chk('apex-supplier-portal', scope='supplier-orders.read')['allowedVendors']]
apex_list = stub('/erp/v1/purchase-orders', {'vendor_id': ','.join(apex_vendors), 'status': '01,02'})
sc_po = po_state('4500123532')
sc_conf = {**conf, "confirmation_no": "7100000102", "po_number": "4500123532", "po_revision": 1, "conf_category": "AC", "conf_category_text": S['CONF_CATEGORIES']['AC'],
           "vendor_reference": "SC-ACK-123456", "note": "80 now, rest next month.", "status": "IN_REVIEW",
           "items": [{"item_no": "00010", "confirmed_qty": "80.000", "confirmed_date": "20261222", "reject_reason": None}]}
saga_contents = [{"poNumber": "4500123457", "poLine": 10, "quantity": {"value": 10, "uom": "EA"}}]
saga_body = {**shp_body, "asnNumber": "ASN-SAGA-{{runId}}", "contents": saga_contents, "tender": True}
saga_ship = lambda sid, ms, cancel=None: shipment(sid, 'ASN-SAGA-123456', ms, contents=saga_contents, cancel=cancel)
saga_dlv = {"delivery_no": "180000202", "vendor_id": "0000710245", "asn_reference": "ASN-SAGA-123456", "status": "POSTED",
            "items": [{"po_number": "4500123457", "item_no": "00010", "quantity": "10.000"}], "posted_at": NOW_SAP, "reversed_at": None}
shp107 = S['map_shp'](SHP('SHP-20260915-00107'))


# ─── Scenario: POST /shipments happy path, with the façade request/response mapping shown end to end ───
FACADE_ASN_REQUEST = {
    "supplierId": "SUP-100245", "shipmentNoticeNumber": "ASN-440882-{{runId}}", "carrierCode": "UPS", "trackingNumber": "1Z999AA10123456784",
    "shipFrom": {"siteCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "region": "GA", "postalCode": "30301", "countryCode": "US"},
    "shipTo": {"siteCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "addressLine1": "100 Manufacturing Way", "city": "Auburn Hills", "region": "MI", "postalCode": "48326", "countryCode": "US"},
    "plannedShipAt": "{{shipDate}}", "expectedArrivalAt": "{{etaDate}}",
    "lines": [{"purchaseOrderId": "PO-4500123456", "lineNumber": 10, "shippedQuantity": 50, "unitOfMeasure": "EA", "lotNumber": "LOT-88291"},
              {"purchaseOrderId": "PO-4500123467", "lineNumber": 20, "shippedQuantity": 120, "unitOfMeasure": "EA", "lotNumber": "LOT-88292"}],
    "packages": [{"packageId": "PALLET-1001", "packageType": "PALLET", "grossWeight": 240, "weightUnit": "KG"}],
}
asn_origin = {"locationCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "state": "GA", "zip": "30301", "country": "US"}
asn_dest = {"locationCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "street": "100 Manufacturing Way", "city": "Auburn Hills", "state": "MI", "zip": "48326", "country": "US"}
asn_contents = [{"poNumber": "4500123456", "poLine": 10, "quantity": {"value": 50, "uom": "EA"}, "lotNumber": "LOT-88291"},
                {"poNumber": "4500123467", "poLine": 20, "quantity": {"value": 120, "uom": "EA"}, "lotNumber": "LOT-88292"}]
asn_hus = [{"huId": "PALLET-1001", "type": "PLT", "weight": {"value": 240, "unit": "kg"}}]
asn_tms_body = {"asnNumber": "ASN-440882-{{runId}}", "supplierCode": "SUP-100245", "carrier": {"carrierCode": "UPS", "trackingId": "1Z999AA10123456784"},
                "route": {"origin": asn_origin, "destination": asn_dest}, "schedule": {"plannedShipDate": "{{shipDate}}", "estimatedArrival": "{{etaDate}}"},
                "contents": asn_contents, "handlingUnits": asn_hus, "tender": True}
asn_erp_body = {"asn_reference": "ASN-440882-{{runId}}", "vendor_id": "{{scVendor}}",
                "items": [{"po_number": "4500123456", "item_no": "00010", "quantity": 50}, {"po_number": "4500123467", "item_no": "00020", "quantity": 120}]}


def asn_shipment(milestone='TND', cancel=None):
    o = shipment('SHP-20260924-00205', 'ASN-440882-123456', milestone, tracking='1Z999AA10123456784', contents=asn_contents, cancel=cancel)
    o['route'] = {"origin": {**{k: None for k in ('street', 'city', 'state', 'zip')}, **asn_origin}, "destination": asn_dest}
    o['route']['origin'] = {k: o['route']['origin'][k] for k in ('locationCode', 'name', 'street', 'city', 'state', 'zip', 'country')}
    o['handlingUnits'] = asn_hus
    return o


asn_dlv = {"delivery_no": "180000203", "vendor_id": "0000710245", "asn_reference": "ASN-440882-123456", "status": "POSTED",
           "items": [{"po_number": "4500123456", "item_no": "00010", "quantity": "50.000"}, {"po_number": "4500123467", "item_no": "00020", "quantity": "120.000"}],
           "posted_at": NOW_SAP, "reversed_at": None}

# The façade response, built from the TMS shipment exactly like the script below does (used in the description).
FACADE_ASN_RESPONSE = {
    "shipmentId": "SHP-20260924-00205", "supplierId": "SUP-100245", "shipmentNoticeNumber": "ASN-440882-123456", "carrierCode": "UPS", "trackingNumber": "1Z999AA10123456784",
    "shipFrom": {"siteCode": "SUP-ATL-01", "name": "Supplier Distribution Center", "city": "Atlanta", "region": "GA", "postalCode": "30301", "countryCode": "US"},
    "shipTo": {"siteCode": "US-AUBURN-HILLS", "name": "Manufacturing Site", "addressLine1": "100 Manufacturing Way", "city": "Auburn Hills", "region": "MI", "postalCode": "48326", "countryCode": "US"},
    "plannedShipAt": "2026-09-26T12:00:00.000Z", "expectedArrivalAt": "2026-09-30T12:00:00.000Z",
    "lines": [{"purchaseOrderId": "PO-4500123456", "lineNumber": 10, "shippedQuantity": 50, "unitOfMeasure": "EA", "lotNumber": "LOT-88291"},
              {"purchaseOrderId": "PO-4500123467", "lineNumber": 20, "shippedQuantity": 120, "unitOfMeasure": "EA", "lotNumber": "LOT-88292"}],
    "packages": [{"packageId": "PALLET-1001", "packageType": "PALLET", "grossWeight": 240, "weightUnit": "KG"}],
    "status": "SUBMITTED", "purchaseOrders": ["PO-4500123456", "PO-4500123467"], "createdAt": NOW_ISO, "lastUpdatedAt": NOW_ISO,
}

# Response mapping in JavaScript: TMS shipment -> façade Shipment. The same code an iPaaS mapping would express.
FACADE_MAP_JS = [
    "// Build the façade 201 response from the TMS shipment saved in step 2.",
    "const s = JSON.parse(pm.collectionVariables.get('scShipmentJson'));",
    "const STATUS = { PLN: 'DRAFT', TND: 'SUBMITTED', ITR: 'IN_TRANSIT', DLV: 'DELIVERED', EXC: 'DELAYED', CXL: 'CANCELLED' };",
    "const PKG = { PLT: 'PALLET', CTN: 'CARTON', CRT: 'CRATE', OTH: 'OTHER' };",
    "const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));",
    "const addr = (l) => clean({ siteCode: l.locationCode, name: l.name, addressLine1: l.street, city: l.city, region: l.state, postalCode: l.zip, countryCode: l.country });",
    "const facade = clean({",
    "  shipmentId: s.shipmentId, supplierId: s.supplierCode, shipmentNoticeNumber: s.asnNumber,",
    "  carrierCode: s.carrier.carrierCode, trackingNumber: s.carrier.trackingId,",
    "  shipFrom: addr(s.route.origin), shipTo: addr(s.route.destination),",
    "  plannedShipAt: s.schedule.plannedShipDate, expectedArrivalAt: s.schedule.estimatedArrival,",
    "  lines: s.contents.map((c) => ({ purchaseOrderId: 'PO-' + c.poNumber, lineNumber: c.poLine, shippedQuantity: c.quantity.value, unitOfMeasure: c.quantity.uom, lotNumber: c.lotNumber })),",
    "  packages: (s.handlingUnits || []).map((h) => ({ packageId: h.huId, packageType: PKG[h.type], grossWeight: h.weight && h.weight.value, weightUnit: h.weight && h.weight.unit.toUpperCase() })),",
    "  status: STATUS[s.milestone.code],",
    "  purchaseOrders: [...new Set(s.contents.map((c) => 'PO-' + c.poNumber))],",
    "  createdAt: s.audit.createdAt, lastUpdatedAt: s.audit.updatedAt,",
    "});",
    "pm.collectionVariables.set('facadeShipment', JSON.stringify(facade, null, 2));",
    "console.log('Façade response 201 Created', facade);",
    "pm.test('Façade status is SUBMITTED', () => pm.expect(facade.status).to.eql('SUBMITTED'));",
    "pm.test('Façade lists both purchase orders', () => pm.expect(facade.purchaseOrders).to.eql(['PO-4500123456', 'PO-4500123467']));",
    "pm.visualizer.set('<h3 style=\"font-family:sans-serif\">Façade response: 201 Created</h3><pre>{{json}}</pre>', { json: JSON.stringify(facade, null, 2) });",
]

md_json = lambda o: "```json\n" + json.dumps(o, indent=2, ensure_ascii=False) + "\n```"
ASN_FOLDER_DESC = f"""The happy path of the façade's `POST /shipments`: one shipment for **two purchase orders**, three backend calls, then a clean-up so it can run again. Read the steps' descriptions for the field mappings; the last step's **Visualize** tab (and the Postman console) shows the façade response built from the backend answers.

| Step | Call | Façade status if it fails |
|---|---|---|
| 1 | SRM check, scope write, `supplierCode` = `supplierId` | 403 when `allowed` is false; 422 when `supplier.asnEnabled` is false |
| 2 | TMS `POST /shipments` | 409, 422 or 503 mapped from the TMS fault (nothing to compensate) |
| 3 | ERP `POST /inbound-deliveries` | cancel the TMS shipment first (see scenario 5), then map the ERP error |

**The façade request this scenario implements** (the façade spec's own example, with a unique ASN):

{md_json(FACADE_ASN_REQUEST)}
"""

scenarios = [
    folder('1. Get one purchase order (GET /purchase-orders/{id})', [
        a(req('ERP: the purchase order', 'GET', 'erp', '/v1/purchase-orders/4500123458', pre=NEW_RUN, tests=[save('scVendor', 'pm.response.json().data.vendor_id')],
              example=(200, {"data": po58}), desc='Step 1 of 2. Strip PO- from the façade id. The answer already has items, ship_to (façade shipTo) and purch_org_name (façade buyingOrganization).'), SC_ERP),
        a(req('SRM: may apex-supplier-portal read it?', 'GET', 'srm', '/v1/entitlements/apex-supplier-portal/check', query={"scope": "supplier-orders.read", "erpVendorNumber": "{{scVendor}}"},
              tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);", "pm.test('Resolved supplierId', () => pm.expect(pm.response.json().supplierCode).to.eql('SUP-100245'));"],
              example=(200, chk('apex-supplier-portal', scope='supplier-orders.read', erpVendorNumber='0000710245')),
              desc='Step 2 of 2. One call authorizes and turns the ERP vendor_id into the façade supplierId. Then transform and return.'), SC_SRM),
    ], desc='Two calls: ERP, then SRM. Everything else is transformation (docs/MAPPING.md, section 2).'),
    folder('2. List purchase orders (GET /purchase-orders)', [
        a(req('SRM: which suppliers may apex-supplier-portal read?', 'GET', 'srm', '/v1/entitlements/apex-supplier-portal/check', query={"scope": "supplier-orders.read"},
              tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);", save('scVendors', "pm.response.json().allowedVendors.map(v => v.erpVendorNumber).join(',')")],
              example=(200, chk('apex-supplier-portal', scope='supplier-orders.read')),
              desc="Step 1 of 2. Without a supplierId filter, allowedVendors gives the vendor numbers to query (and to map back to supplierId). Add supplierCode=... when the façade call has supplierId."), SC_SRM),
        a(req('ERP: open orders for those vendors', 'GET', 'erp', '/v1/purchase-orders', query={"vendor_id": "{{scVendors}}", "status": "01,02", "limit": 50},
              example=(200, apex_list), desc='Step 2 of 2. Façade status OPEN,PARTIALLY_ACKNOWLEDGED becomes 01,02. pageToken maps to page.'), SC_ERP),
    ], desc='Two calls: SRM, then ERP.'),
    folder('3. Acknowledge a purchase order (POST /purchase-orders/{id}/acknowledgements)', [
        a(req('Setup: create a fresh PO (not part of the façade flow)', 'POST', 'erp', '/v1/purchase-orders', expect=201, pre=NEW_RUN, body=po_body,
              tests=[save('scPo', 'pm.response.json().data.po_number')], example=(201, {"data": sc_po}), desc='Gives the scenario an open PO so it can be re-run.'), SC_ERP),
        a(req('ERP: the purchase order', 'GET', 'erp', '/v1/purchase-orders/{{scPo}}', tests=[save('scVendor', 'pm.response.json().data.vendor_id'), save('scEtag', "pm.response.headers.get('ETag')")],
              example=(200, {"data": sc_po}), desc='Step 1 of 3. Gives vendor_id for the check and the ETag for the optional If-Match.'), SC_ERP),
        a(req('SRM: may apex-supplier-portal write?', 'GET', 'srm', '/v1/entitlements/apex-supplier-portal/check', query={"scope": "supplier-orders.write", "erpVendorNumber": "{{scVendor}}"},
              tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);"],
              example=(200, chk('apex-supplier-portal', scope='supplier-orders.write', erpVendorNumber='0000710245')), desc='Step 2 of 3. allowed=false becomes a façade 403.'), SC_SRM),
        a(req('ERP: post the confirmation (ACCEPT_WITH_CHANGES = AC)', 'POST', 'erp', '/v1/purchase-orders/{{scPo}}/confirmations', expect=201, headers={"If-Match": "{{scEtag}}"},
              body={"conf_category": "AC", "vendor_reference": "SC-ACK-{{runId}}", "note": "80 now, rest next month.", "items": [{"item_no": "00010", "confirmed_qty": 80, "confirmed_date": "20261222"}]},
              tests=["pm.test('IN_REVIEW (façade PENDING_REVIEW)', () => pm.expect(pm.response.json().data.status).to.eql('IN_REVIEW'));"], example=(201, {"data": sc_conf}),
              desc='Step 3 of 3. lineNumber 10 becomes item_no 00010 and dates lose their dashes. IN_REVIEW maps to façade status PENDING_REVIEW.'), SC_ERP),
        a(req('Same acknowledgement again (409)', 'POST', 'erp', '/v1/purchase-orders/{{scPo}}/confirmations', expect=409,
              body={"conf_category": "AB", "items": [{"item_no": "00010", "confirmed_qty": 100}]},
              example=(409, erpErr('CONFIRMATION_EXISTS', 'Confirmation 7100000102 already exists for revision 1 of PO 4500123532')),
              desc='The façade returns 409 ACKNOWLEDGEMENT_ALREADY_EXISTS.'), SC_ERP),
    ], desc='Three calls: ERP read, SRM check, ERP write.'),
    folder('4. Create an ASN (POST /shipments)', [
        a(req('SRM: may apex-supplier-portal send ASNs for SUP-100245?', 'GET', 'srm', '/v1/entitlements/apex-supplier-portal/check',
              query={"scope": "supplier-orders.write", "supplierCode": "SUP-100245"}, pre=NEW_RUN,
              tests=["pm.test('Allowed and ASN-enabled', () => { const r = pm.response.json(); pm.expect(r.allowed).to.be.true; pm.expect(r.supplier.asnEnabled).to.be.true; });",
                     save('scVendor', 'pm.response.json().supplier.erpVendorNumber')],
              example=(200, chk('apex-supplier-portal', scope='supplier-orders.write', supplierCode='SUP-100245')),
              desc="Step 1 of 3. `supplierId` goes in as `supplierCode`. Keep `supplier.erpVendorNumber` (`0000710245`) for step 3 and check `supplier.asnEnabled`."), SC_SRM),
        a(req('TMS: create the shipment (façade body → TMS dialect)', 'POST', 'tms', '/v1/shipments', expect=201, body=asn_tms_body,
              tests=[save('scShipment', 'pm.response.json().shipmentId'), save('scShipmentJson', 'JSON.stringify(pm.response.json())'),
                     "pm.test('Tendered (façade SUBMITTED)', () => pm.expect(pm.response.json().milestone.code).to.eql('TND'));",
                     "pm.test('UPS resolved to SCAC UPSN', () => pm.expect(pm.response.json().carrier.scac).to.eql('UPSN'));"],
              example=(201, asn_shipment()),
              desc="""Step 2 of 3. The request body is the façade request in the TMS dialect:

| Façade | TMS |
|---|---|
| `shipmentNoticeNumber` | `asnNumber` |
| `supplierId` | `supplierCode` (same value) |
| `carrierCode`, `trackingNumber` | `carrier.carrierCode`, `carrier.trackingId` |
| `shipFrom`, `shipTo` | `route.origin`, `route.destination`: `siteCode`→`locationCode`, `addressLine1`→`street`, `region`→`state`, `postalCode`→`zip`, `countryCode`→`country` |
| `plannedShipAt`, `expectedArrivalAt` | `schedule.plannedShipDate`, `schedule.estimatedArrival` |
| `lines[]` | `contents[]`: strip `PO-` into `poNumber`, `lineNumber`→`poLine`, `shippedQuantity` + `unitOfMeasure` → `quantity {value, uom}` |
| `packages[]` | `handlingUnits[]`: `packageId`→`huId`, `PALLET`→`PLT` (`CARTON` `CTN`, `CRATE` `CRT`, `OTHER` `OTH`), `grossWeight` + `weightUnit` → `weight {value, unit}` in lower case |
| (none) | `tender: true`, so the shipment is submitted to the carrier at once |

Saves the shipment for the response mapping in step 3."""), SC_TMS),
        a(req('ERP: post the inbound delivery (lines → PO items)', 'POST', 'erp', '/v1/inbound-deliveries', expect=201, body=asn_erp_body,
              tests=[save('scDelivery', 'pm.response.json().data.delivery_no')] + FACADE_MAP_JS,
              example=(201, {"data": asn_dlv}),
              desc=f"""Step 3 of 3. Reserves the shipped quantity on both POs.

| Façade | ERP |
|---|---|
| `shipmentNoticeNumber` | `asn_reference` |
| `supplierId` | `vendor_id` = `supplier.erpVendorNumber` from step 1 |
| `lines[].purchaseOrderId` | `items[].po_number` without `PO-` |
| `lines[].lineNumber` | `items[].item_no`, zero-padded to 5 digits (`20` → `"00020"`) |
| `lines[].shippedQuantity` | `items[].quantity` |

If this call fails, the façade cancels the TMS shipment before answering (scenario 5). On success the façade answers **201** with the TMS shipment in façade shape. This request's test script does that mapping (milestone `TND` → status `SUBMITTED`, `PLT` → `PALLET`, `kg` → `KG`, `PO-` added back, `purchaseOrders` = distinct POs) and shows the result in the **Visualize** tab:

{md_json(FACADE_ASN_RESPONSE)}"""), SC_ERP),
        a(req('Clean up: reverse the delivery (not part of the façade flow)', 'POST', 'erp', '/v1/inbound-deliveries/{{scDelivery}}/reverse', body={"reason": "Postman scenario clean-up"},
              example=(200, {"data": {**asn_dlv, "status": "REVERSED", "reversed_at": NOW_SAP}}), desc='Gives the 50 and 120 EA back to the two POs so the scenario can run again.'), SC_ERP),
        a(req('Clean up: cancel the shipment (not part of the façade flow)', 'POST', 'tms', '/v1/shipments/{{scShipment}}/cancel', body={"reason": "Postman scenario clean-up"},
              example=(200, asn_shipment('CXL', 'Postman scenario clean-up'))), SC_TMS),
    ], desc=ASN_FOLDER_DESC),
    folder('5. Create an ASN when the ERP step fails (POST /shipments, compensation)', [
        a(req('SRM: may apex-supplier-portal write for SUP-100245?', 'GET', 'srm', '/v1/entitlements/apex-supplier-portal/check', query={"scope": "supplier-orders.write", "supplierCode": "SUP-100245"}, pre=NEW_RUN,
              tests=["pm.test('Allowed and ASN-enabled', () => { const r = pm.response.json(); pm.expect(r.allowed).to.be.true; pm.expect(r.supplier.asnEnabled).to.be.true; });"],
              example=(200, chk('apex-supplier-portal', scope='supplier-orders.write', supplierCode='SUP-100245')),
              desc='Step 1 of 3. Also gives supplier.erpVendorNumber for step 3 and supplier.asnEnabled.'), SC_SRM),
        a(req('TMS: create the shipment', 'POST', 'tms', '/v1/shipments', expect=201, body=saga_body, tests=[save('sagaShipment', 'pm.response.json().shipmentId')],
              example=(201, saga_ship('SHP-20260924-00203', 'TND')), desc='Step 2 of 3. The façade carrierCode goes straight into carrier.carrierCode.'), SC_TMS),
        a(req('ERP: post the inbound delivery (fails: simulated 503)', 'POST', 'erp', '/v1/inbound-deliveries', expect=503, headers={"x-mock-status": "503"},
              body={"asn_reference": "ASN-SAGA-{{runId}}", "vendor_id": "0000710245", "items": [{"po_number": "4500123457", "item_no": "00010", "quantity": 10}]},
              example=(503, erpErr('SIMULATED_FAILURE', 'Simulated 503 requested via x-mock-status header')), desc='Step 3 of 3 fails. Needs CHAOS_ENABLED=true.'), SC_ERP),
        a(req('TMS: compensate by cancelling the shipment', 'POST', 'tms', '/v1/shipments/{{sagaShipment}}/cancel', body={"reason": "Compensation: ERP inbound delivery failed"},
              tests=["pm.test('CXL', () => pm.expect(pm.response.json().milestone.code).to.eql('CXL'));"],
              example=(200, saga_ship('SHP-20260924-00203', 'CXL', 'Compensation: ERP inbound delivery failed')), desc='The façade then returns 503 DOWNSTREAM_SERVICE_UNAVAILABLE.'), SC_TMS),
        a(req('Retry: TMS create (same ASN)', 'POST', 'tms', '/v1/shipments', expect=201, body=saga_body, tests=[save('sagaShipment', 'pm.response.json().shipmentId')],
              example=(201, saga_ship('SHP-20260924-00204', 'TND')), desc='Allowed because the cancelled shipment released the ASN number.'), SC_TMS),
        a(req('Retry: ERP inbound delivery succeeds', 'POST', 'erp', '/v1/inbound-deliveries', expect=201,
              body={"asn_reference": "ASN-SAGA-{{runId}}", "vendor_id": "0000710245", "items": [{"po_number": "4500123457", "item_no": "00010", "quantity": 10}]},
              tests=[save('sagaDelivery', 'pm.response.json().data.delivery_no')], example=(201, {"data": saga_dlv}), desc='The façade returns 201 with the mapped TMS shipment (status SUBMITTED).'), SC_ERP),
        a(req('Clean up: reverse the delivery (not part of the façade flow)', 'POST', 'erp', '/v1/inbound-deliveries/{{sagaDelivery}}/reverse', body={"reason": "Postman scenario clean-up"},
              example=(200, {"data": {**saga_dlv, "status": "REVERSED", "reversed_at": NOW_SAP}}), desc='Gives the quantity back so the scenario can run again.'), SC_ERP),
        a(req('Clean up: cancel the shipment (not part of the façade flow)', 'POST', 'tms', '/v1/shipments/{{sagaShipment}}/cancel', body={"reason": "Postman scenario clean-up"},
              example=(200, saga_ship('SHP-20260924-00204', 'CXL', 'Postman scenario clean-up'))), SC_TMS),
    ], desc='SRM check, TMS shipment, ERP delivery; if the ERP step fails, cancel the TMS shipment. Then a successful retry and a clean-up.'),
    folder('6. Track a shipment (GET /shipments/{id})', [
        a(req('TMS: the shipment', 'GET', 'tms', '/v1/shipments/SHP-20260915-00107', pre=NEW_RUN, tests=[save('scSupplier', 'pm.response.json().supplierCode')], example=(200, shp107),
              desc='Step 1 of 2. Milestone EXC becomes façade status DELAYED.'), SC_TMS),
        a(req('SRM: may prc-edi-bridge read it?', 'GET', 'srm', '/v1/entitlements/prc-edi-bridge/check', query={"scope": "supplier-orders.read", "supplierCode": "{{scSupplier}}"},
              tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);"],
              example=(200, chk('prc-edi-bridge', scope='supplier-orders.read', supplierCode=shp107['supplierCode'])), desc='Step 2 of 2.'), SC_SRM),
    ], desc='Two calls: TMS, then SRM.'),
    folder('7. Governance: blocked and on-hold suppliers', [
        a(req('Write for an on-hold supplier', 'GET', 'srm', '/v1/entitlements/jabil-ops-console/check', query={"scope": "supplier-orders.write", "supplierCode": "SUP-100518"},
              tests=["pm.test('SUPPLIER_ON_HOLD', () => pm.expect(pm.response.json().reason).to.eql('SUPPLIER_ON_HOLD'));"],
              example=(200, chk('jabil-ops-console', scope='supplier-orders.write', supplierCode='SUP-100518')), desc='An internal consumer with access to every supplier still cannot write for one on hold.'), SC_SRM),
        a(req('Revoked consumer', 'GET', 'srm', '/v1/entitlements/mmw-legacy-portal/check', query={"scope": "supplier-orders.read", "supplierCode": "SUP-100627"},
              tests=["pm.test('CONSUMER_INACTIVE', () => pm.expect(pm.response.json().reason).to.eql('CONSUMER_INACTIVE'));"],
              example=(200, chk('mmw-legacy-portal', scope='supplier-orders.read', supplierCode='SUP-100627'))), SC_SRM),
        a(req('Multi-supplier network sees its suppliers', 'GET', 'srm', '/v1/entitlements/asia-pacific-edi-network/check', query={"scope": "supplier-orders.write", "supplierCode": "SUP-100962"},
              tests=["pm.test('Allowed', () => pm.expect(pm.response.json().allowed).to.be.true);"],
              example=(200, chk('asia-pacific-edi-network', scope='supplier-orders.write', supplierCode='SUP-100962'))), SC_SRM),
    ], desc='Decisions the façade turns into 403 responses.'),
]

top = [
    folder('ERP - Purchasing', erp_items, desc='SAP-flavoured purchasing system of record. snake_case, YYYYMMDD dates, decimals as strings, {data, pagination} envelope, page/limit paging.', auth=apikey('erpApiKey')),
    folder('SRM - Supplier master', srm_items, desc='Supplier master, consumer entitlements and the check endpoint (authorization plus supplier/vendor resolution). Nested camelCase, offset paging.', auth=apikey('srmApiKey')),
    folder('TMS - Logistics', tms_items, desc='Shipments, tracking events and carriers. Milestone codes, nested quantities, cursor paging.', auth=apikey('tmsApiKey')),
    folder('Scenarios - façade walkthroughs', scenarios, desc='For each façade operation, the exact backend calls the iPaaS makes, in order. Each scenario can be run on its own.'),
]

# ─── Post-processing: examples, descriptions, variable guards ─────────────
VAR_RE = re.compile(r'\{\{([A-Za-z0-9_]+)\}\}')
SET_RE = re.compile(r"collectionVariables\.set\('([A-Za-z0-9_]+)'")


def walk(items, path=()):
    for it in items:
        if 'item' in it: yield from walk(it['item'], path + (it['name'],))
        else: yield path, it


def script(it, listen):
    return '\n'.join(l for e in it.get('event', []) if e['listen'] == listen for l in e['script']['exec'])


def used_vars(it):
    r = it['request']
    text = r['url']['raw'] + ' ' + r.get('body', {}).get('raw', '') + ' ' + ' '.join(h['value'] for h in r['header'])
    return sorted({v for v in VAR_RE.findall(text) if v not in BASE_VARS})


setters = {}
for path, it in walk(top):
    for v in SET_RE.findall(script(it, 'prerequest') + '\n' + script(it, 'test')):
        setters.setdefault(v, ' / '.join(path + (it['name'],)))

SAMPLE = {'runId': '123456', 'shipDate': '2026-09-26T12:00:00Z', 'etaDate': '2026-09-30T12:00:00Z', 'newEta': '2026-10-02T12:00:00Z'}
missing, variables_used = [], set()
for path, it in walk(top):
    m = it.pop('_meta')
    r = it['request']
    needs = used_vars(it)
    variables_used.update(needs)
    own_pre = set(SET_RE.findall(script(it, 'prerequest')))
    guard = [v for v in needs if v not in own_pre]
    for v in guard:
        if v not in setters: raise SystemExit(f"{' / '.join(path + (it['name'],))}: {{{{{v}}}}} is never set by any request")

    # 1. example
    ex = m['example']
    if ex is None:
        if m['expect'] in (204, 304):
            ex = (m['expect'], None)
        elif m['method'] == 'GET' and m['expect'] == 200 and not needs:
            q = {k: VAR_RE.sub(lambda x: SAMPLE.get(x.group(1), x.group(0)), str(v)) for k, v in m['query'].items()}
            code, body = S['route']('GET', f"/{m['svc']}{m['path']}", q, {})
            if code != 200: raise SystemExit(f"stub returned {code} for {m['svc']} {m['path']}")
            ex = (200, body)
        else:
            missing.append(' / '.join(path + (it['name'],)))
            continue
    code, body = ex
    orig = {k: v for k, v in r.items() if k != 'auth'}
    it['response'] = [{"name": f"{code} {STATUS_TEXT.get(code, '')}".strip(), "originalRequest": copy.deepcopy(orig), "status": STATUS_TEXT.get(code, 'OK'), "code": code,
                       "_postman_previewlanguage": "json" if body is not None else "text",
                       "header": [{"key": "Content-Type", "value": "application/json; charset=utf-8"}] if body is not None else [],
                       "body": json.dumps(body, indent=2, ensure_ascii=False) if body is not None else ""}]

    # 2. description
    parts = [m['desc']] if m['desc'] else []
    exp = m['expect'] if isinstance(m['expect'], (list, tuple)) else [m['expect']]
    parts.append('**Expects:** ' + ', '.join(f"`{c} {STATUS_TEXT.get(c, '')}`" for c in exp))
    if guard:
        parts.append('**Needs:** ' + '; '.join(f"`{{{{{v}}}}}` from *{setters[v]}*" for v in guard) + '. Run that request first, or run the folder in order.')
    saves = SET_RE.findall(script(it, 'test'))
    if saves: parts.append('**Saves:** ' + ', '.join(f'`{v}`' for v in saves))
    r['description'] = '\n\n'.join(parts)

    # 3. guard: stop with a clear message instead of sending a request with an empty ID
    if guard:
        lines = [f"const needed = {json.dumps({v: setters[v] for v in guard})};",
                 "Object.entries(needed).forEach(([v, from]) => { if (!pm.variables.get(v)) throw new Error(`{{${v}}} is empty. Send \"${from}\" first, or run the folder in order.`); });"]
        pre = next((e for e in it['event'] if e['listen'] == 'prerequest'), None)
        if pre: pre['script']['exec'] += lines
        else: it['event'].insert(0, {"listen": "prerequest", "script": {"type": "text/javascript", "exec": lines}})

if missing:
    raise SystemExit('No example response for:\n  - ' + '\n  - '.join(missing))

DESC = """Every operation of the three mock backends (ERP, SRM, TMS) behind the Supplier Order Collaboration API façade, plus a **Scenarios** folder with the exact calls the façade makes for each of its operations.

**Quick start**
1. Import this collection and one environment from `postman/` (Local, Local separate ports, or Tunnel), or just edit the `baseUrl` collection variable.
2. Run a backend folder, or the whole collection, with the Collection Runner. Requests that create records save their IDs (`poNumber`, `supplierCode`, `shipmentId`, ...) in collection variables for the requests after them, and each backend folder cleans up after itself.

**Sending single requests**
Requests on seed data (fixed IDs such as PO 4500123458) work on their own. A request that uses an ID created by an earlier request says so in its description (**Needs**) and, if that variable is still empty, stops before sending with a message naming the request to run first.

**What you get on every request:** a description, tests, and a saved example response.

**API keys:** `erpApiKey`, `srmApiKey`, `tmsApiKey`, sent as `x-api-key` by folder-level auth. Chaos requests (503, delays) need `CHAOS_ENABLED=true`, the server default.

Newman: `npm run postman`"""

variables = [("baseUrl", "http://localhost:3000"), ("erpUrl", "{{baseUrl}}/erp"), ("srmUrl", "{{baseUrl}}/srm"), ("tmsUrl", "{{baseUrl}}/tms"),
             ("erpApiKey", "erp-demo-key"), ("srmApiKey", "srm-demo-key"), ("tmsApiKey", "tms-demo-key"), ("runId", ""), ("shipDate", ""), ("etaDate", ""), ("newEta", "")]
variables += [(v, "") for v in sorted((variables_used | set(setters)) - {k for k, _ in variables})]
var_desc = {v: f"Set by {setters[v]}" for v in setters}
coll = {
    "info": {"_postman_id": str(uuid.uuid5(uuid.NAMESPACE_URL, 'lbrenman/mock-purchase-order-backend')), "name": "Mock Purchase Order Backends (ERP, SRM, TMS)", "description": DESC,
             "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
    "item": top,
    "event": [{"listen": "prerequest", "script": {"type": "text/javascript", "exec": [
        "if (!pm.collectionVariables.get('runId')) pm.collectionVariables.set('runId', String(Date.now()).slice(-6));",
        "// Ship and arrival dates relative to now, so shipment requests always have a valid schedule.",
        "const d = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 13) + ':00:00Z';",
        "pm.collectionVariables.set('shipDate', d(2)); pm.collectionVariables.set('etaDate', d(6)); pm.collectionVariables.set('newEta', d(8));"]}}],
    "variable": [{"key": k, "value": v, "type": "string", **({"description": var_desc[k]} if k in var_desc else {})} for k, v in variables],
}
OUT.mkdir(exist_ok=True)
(OUT / 'mock-po-backends.postman_collection.json').write_text(json.dumps(coll, indent=2, ensure_ascii=False) + '\n')


def env(name, values):
    return {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, name)), "name": name, "values": [{"key": k, "value": v, "type": "secret" if 'Key' in k else "default", "enabled": True} for k, v in values], "_postman_variable_scope": "environment"}


keys = [("erpApiKey", "erp-demo-key"), ("srmApiKey", "srm-demo-key"), ("tmsApiKey", "tms-demo-key")]
(OUT / 'local.postman_environment.json').write_text(json.dumps(env('Mock PO Backends - Local (combined, port 3000)', [("baseUrl", "http://localhost:3000")] + keys), indent=2) + '\n')
(OUT / 'local-separate.postman_environment.json').write_text(json.dumps(env('Mock PO Backends - Local (separate ports)', [("erpUrl", "http://localhost:3001/erp"), ("srmUrl", "http://localhost:3002/srm"), ("tmsUrl", "http://localhost:3003/tms")] + keys), indent=2) + '\n')
(OUT / 'tunnel.postman_environment.json').write_text(json.dumps(env('Mock PO Backends - Tunnel (ngrok or Codespaces)', [("baseUrl", "https://REPLACE-ME.ngrok-free.app")] + keys), indent=2) + '\n')

n = sum(1 for _ in walk(top))
print(f"requests {n}, with examples {sum(1 for _, i in walk(top) if i.get('response'))}, with descriptions {sum(1 for _, i in walk(top) if i['request'].get('description'))}")
