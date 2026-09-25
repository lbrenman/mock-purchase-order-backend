"""Rebuilds src/data/{erp,srm,tms}.json from the hand-curated v1 records in tools/seed/base/.

Deterministic (fixed random seed): running it reproduces the committed seed files exactly.
Anchor records from the base files are kept unchanged; everything else is generated so that the
three systems stay consistent (see tools/validate-seed.js).

    python3 tools/seed/expand_seed.py      # or: npm run build:seed
    npm run validate:seed                  # always run afterwards

To change the data: edit the base files (hand-curated records) or the lists below, rerun, validate,
then `npm run seed:reset` to load it. Keep seeded IDs below the runtime sequences:
confirmations < 7100000101, deliveries < 180000201, shipment suffix < 00200.
"""
import json, random, datetime as dt
from pathlib import Path

random.seed(20260924)
BASE = Path(__file__).resolve().parent / 'base'
ROOT = Path(__file__).resolve().parents[2] / 'src' / 'data'
erp = json.load(open(BASE / 'erp.json'))
srm = json.load(open(BASE / 'srm.json'))
tms = json.load(open(BASE / 'tms.json'))
TODAY = dt.datetime(2026, 9, 24, 12, 0, tzinfo=dt.timezone.utc)

def iso(d): return d.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
def day(d): return d.strftime('%Y-%m-%d')
def sapd(d): return d.strftime('%Y%m%d')

# ─── ERP reference data ────────────────────────────────────────────────
erp['purchasing_orgs'] += [
    {"code": "JBCN", "name": "Jabil-CN", "company_code": "CN01"},
    {"code": "JBMY", "name": "Jabil-MY", "company_code": "MY01"},
    {"code": "JBVN", "name": "Jabil-VN", "company_code": "VN01"},
    {"code": "JBPL", "name": "Jabil-PL", "company_code": "PL01"},
    {"code": "JBHU", "name": "Jabil-HU", "company_code": "HU01"},
]
erp['plants'] += [
    {"plant_code": "1103", "site_code": "US-MEMPHIS", "name": "Jabil Memphis Repair & Distribution", "street": "4600 Distriplex Farms Dr", "city": "Memphis", "region": "TN", "postal_code": "38141", "country": "US"},
    {"plant_code": "1104", "site_code": "US-SAN-JOSE", "name": "Jabil San Jose Blue Sky Center", "street": "30 Great Oaks Blvd", "city": "San Jose", "region": "CA", "postal_code": "95119", "country": "US"},
    {"plant_code": "2102", "site_code": "MX-CHIHUAHUA", "name": "Jabil Chihuahua Operations", "street": "Av. de las Industrias 8901", "city": "Chihuahua", "region": "CHH", "postal_code": "31136", "country": "MX"},
    {"plant_code": "3102", "site_code": "HU-TISZAUJVAROS", "name": "Jabil Tiszaujvaros Plant", "street": "Huszar Andor ut 1", "city": "Tiszaujvaros", "region": "BZ", "postal_code": "3580", "country": "HU"},
    {"plant_code": "3103", "site_code": "PL-KWIDZYN", "name": "Jabil Kwidzyn Campus", "street": "ul. Mickiewicza 49", "city": "Kwidzyn", "region": "PM", "postal_code": "82-500", "country": "PL"},
    {"plant_code": "4102", "site_code": "MY-PENANG", "name": "Jabil Penang Operations", "street": "56 Hilir Sungai Keluang 1", "city": "Bayan Lepas", "region": "PNG", "postal_code": "11900", "country": "MY"},
    {"plant_code": "4103", "site_code": "CN-WUXI", "name": "Jabil Wuxi Campus", "street": "8 Xinhua Road, New District", "city": "Wuxi", "region": "JS", "postal_code": "214028", "country": "CN"},
    {"plant_code": "4104", "site_code": "VN-HCMC", "name": "Jabil Vietnam Saigon Hi-Tech Park", "street": "Lot I-9, D1 Street", "city": "Ho Chi Minh City", "region": "HCM", "postal_code": "700000", "country": "VN"},
]
PLANTS = {p['plant_code']: p for p in erp['plants']}
PLANT_ORG = {'1101': 'JBUS', '1102': 'JBUS', '1103': 'JBUS', '1104': 'JBUS', '2101': 'JBMX', '2102': 'JBMX',
             '3101': 'JBDE', '3102': 'JBHU', '3103': 'JBPL', '4101': 'JBSG', '4102': 'JBMY', '4103': 'JBCN', '4104': 'JBVN'}
ORG_CCY = {'JBUS': 'USD', 'JBMX': 'USD', 'JBDE': 'EUR', 'JBHU': 'EUR', 'JBPL': 'PLN', 'JBSG': 'USD', 'JBMY': 'USD', 'JBCN': 'CNY', 'JBVN': 'USD'}
CCY_FX = {'USD': 1.0, 'EUR': 0.92, 'PLN': 3.95, 'CNY': 7.15}
ORG_BUYERS = {
    'JBUS': ['Maria Alvarez', 'Daniel Okafor', 'Heather Lindqvist', 'Marcus Webb'],
    'JBMX': ['Luis Hernández', 'Sofia Castañeda'],
    'JBDE': ['Katrin Vogel', 'Florian Maier'],
    'JBHU': ['Eszter Nagy'], 'JBPL': ['Tomasz Wiśniewski'],
    'JBSG': ['Wei Ling Tan', 'Rajesh Pillai'], 'JBMY': ['Nurul Aisyah', 'Kenneth Lim'],
    'JBCN': ['Zhang Min', 'Li Hua'], 'JBVN': ['Nguyen Thi Mai'],
}
ORG_TERMS = {'JBUS': ('FCA', 'NET60'), 'JBMX': ('DAP', 'NET45'), 'JBDE': ('DAP', 'NET45'), 'JBHU': ('DAP', 'NET45'),
             'JBPL': ('DAP', 'NET45'), 'JBSG': ('FOB', 'NET90'), 'JBMY': ('FOB', 'NET90'), 'JBCN': ('FOB', 'NET90'), 'JBVN': ('CIP', 'NET60')}

# ─── SRM suppliers ─────────────────────────────────────────────────────
NEW_SUPPLIERS = [
    # code, legal, trading, status, reason, tier, risk, country, onboarded, site(code,type,name,addr,city,region,zip), domain, category, plants
    ("SUP-100812", "Keystone Cable Assemblies Corp.", "Keystone Cable", "ACTIVE", None, "PREFERRED", "LOW", "US", "2017-05-15",
     [("SUP-PIT-01", "SHIP_FROM", "Keystone Cable Pittsburgh Plant", "2200 Liberty Ave", "Pittsburgh", "PA", "15222"),
      ("SUP-PIT-AR", "REMIT_TO", "Keystone Cable Receivables", "PO Box 64410", "Pittsburgh", "PA", "15264")],
     "keystonecable.example.com", "cable", ["1101", "1102", "1103", "2101"]),
    ("SUP-100845", "Shenzhen Brightwave Optoelectronics Co., Ltd.", "Brightwave Opto", "ACTIVE", None, "STRATEGIC", "MEDIUM", "CN", "2016-10-03",
     [("SUP-SZX-01", "SHIP_FROM", "Brightwave Longhua Factory", "No. 88 Minzhi Ave, Longhua", "Shenzhen", "GD", "518131")],
     "brightwave-opto.example.cn", "opto", ["4103", "4101", "1104", "4104"]),
    ("SUP-100859", "Penang Semicon Test Sdn. Bhd.", "PST", "ACTIVE", None, "STRATEGIC", "LOW", "MY", "2015-03-20",
     [("SUP-PEN-01", "SHIP_FROM", "PST Bayan Lepas FIZ", "Plot 102, Bayan Lepas FIZ Phase 4", "Bayan Lepas", "PNG", "11900")],
     "pst-semicon.example.my", "semis", ["4102", "4101", "4103", "1104"]),
    ("SUP-100866", "Saigon Precision Molding JSC", "Saigon Molding", "ACTIVE", None, "APPROVED", "MEDIUM", "VN", "2023-02-14",
     [("SUP-SGN-01", "SHIP_FROM", "SPM Thu Duc Factory", "Lot 21, Linh Trung EPZ", "Thu Duc", "HCM", "700000")],
     "saigonmolding.example.vn", "plastics", ["4104", "4101"]),
    ("SUP-100871", "Kansai Fine Ceramics K.K.", "Kansai Ceramics", "ACTIVE", None, "PREFERRED", "LOW", "JP", "2019-08-01",
     [("SUP-KIX-01", "SHIP_FROM", "Kansai Ceramics Fushimi Works", "3-12 Takeda Tobadono-cho", "Kyoto", "KY", "612-8450")],
     "kansai-ceramics.example.jp", "passives", ["4101", "4102", "1104", "3101"]),
    ("SUP-100884", "Hanbit Display Components Co., Ltd.", "Hanbit Display", "ACTIVE", None, "STRATEGIC", "LOW", "KR", "2018-06-11",
     [("SUP-ICN-01", "SHIP_FROM", "Hanbit Suwon Line 3", "129 Samsung-ro, Yeongtong-gu", "Suwon", "GG", "16677")],
     "hanbit-display.example.kr", "display", ["4103", "4102", "1101", "2102"]),
    ("SUP-100903", "Wisla Metal Stamping Sp. z o.o.", "Wisla Stamping", "ACTIVE", None, "APPROVED", "MEDIUM", "PL", "2021-09-27",
     [("SUP-GDN-01", "SHIP_FROM", "Wisla Gdansk Works", "ul. Kartuska 214", "Gdansk", "PM", "80-122")],
     "wisla-stamping.example.pl", "metal", ["3103", "3102", "3101"]),
    ("SUP-100917", "Danube Magnetics Kft.", "Danube Magnetics", "ON_HOLD", "Financial review - credit limit exceeded", "APPROVED", "MEDIUM", "HU", "2022-04-19",
     [("SUP-BUD-01", "SHIP_FROM", "Danube Magnetics Csepel Plant", "Varosmajor utca 30", "Budapest", "BU", "1211")],
     "danube-magnetics.example.hu", "magnetics", ["3102", "3103", "3101"]),
    ("SUP-100926", "Shannon Thermal Solutions Ltd.", "Shannon Thermal", "ACTIVE", None, "PREFERRED", "LOW", "IE", "2020-01-13",
     [("SUP-SNN-01", "SHIP_FROM", "Shannon Free Zone Unit 7", "Shannon Free Zone East", "Shannon", "CE", "V14 DX24")],
     "shannonthermal.example.ie", "thermal", ["3101", "3103", "1101", "1102"]),
    ("SUP-100938", "Campinas Eletronica Ltda.", "Campinas Eletronica", "ACTIVE", "Conditional approval - quarterly audit", "CONDITIONAL", "HIGH", "BR", "2025-11-05",
     [("SUP-CPQ-01", "SHIP_FROM", "Campinas Eletronica Fabrica 1", "Rod. Dom Pedro I, km 140", "Campinas", "SP", "13086-902")],
     "campinas-eletronica.example.br", "pcba", ["2101", "2102", "1102"]),
    ("SUP-100944", "Maple Ridge Fasteners Inc.", "Maple Ridge", "ACTIVE", None, "APPROVED", "LOW", "CA", "2018-03-02",
     [("SUP-YYZ-01", "SHIP_FROM", "Maple Ridge Mississauga DC", "6800 Kitimat Rd", "Mississauga", "ON", "L5N 5M1")],
     "mapleridgefasteners.example.ca", "fasteners", ["1101", "1102", "1103", "2102"]),
    ("SUP-100951", "Tri-Star Surplus Electronics LLC", "Tri-Star Surplus", "BLOCKED", "Failed counterfeit-risk audit AUD-2026-031", "CONDITIONAL", "HIGH", "US", "2024-07-08",
     [("SUP-PHX-01", "SHIP_FROM", "Tri-Star Tempe Warehouse", "1850 W University Dr", "Tempe", "AZ", "85281")],
     "tristar-surplus.example.com", "semis", ["1104", "1101"]),
    ("SUP-100957", "Chao Phraya Wire & Harness Co., Ltd.", "CP Harness", "ACTIVE", None, "APPROVED", "MEDIUM", "TH", "2022-10-17",
     [("SUP-RYG-01", "SHIP_FROM", "CP Harness Rayong Plant", "Eastern Seaboard IE, 64/22 Moo 4", "Rayong", "RY", "21140")],
     "cpharness.example.th", "cable", ["4102", "4104", "4101"]),
    ("SUP-100962", "Lion City Connectors Pte. Ltd.", "LC Connectors", "ACTIVE", None, "PREFERRED", "LOW", "SG", "2017-12-04",
     [("SUP-SIN-01", "SHIP_FROM", "LCC Woodlands Hub", "11 Woodlands Close #05-12", "Singapore", "SG", "737853")],
     "lcconnectors.example.sg", "connectors", ["4101", "4102", "4104", "4103"]),
    ("SUP-100975", "Sonora Aluminum Castings S. de R.L.", "Sonora Castings", "ACTIVE", None, "APPROVED", "MEDIUM", "MX", "2021-05-24",
     [("SUP-HMO-01", "SHIP_FROM", "Sonora Castings Parque Industrial", "Blvd. Solidaridad 2250", "Hermosillo", "SON", "83299")],
     "sonoracastings.example.mx", "metal", ["2101", "2102", "1102", "1104"]),
    ("SUP-100989", "Carolina Power Magnetics LLC", "CPM", "ACTIVE", None, "PREFERRED", "LOW", "US", "2016-02-29",
     [("SUP-CLT-01", "SHIP_FROM", "CPM Charlotte Distribution", "10100 Westlake Dr", "Charlotte", "NC", "28273"),
      ("SUP-CLT-MF", "MANUFACTURING", "CPM Winding Plant", "455 Industrial Dr", "Gastonia", "NC", "28052")],
     "carolinapowermag.example.com", "magnetics", ["1102", "1101", "1103"]),
    ("SUP-100996", "Rhein-Main Sensorik AG", "RM Sensorik", "ACTIVE", "Newly onboarded - no orders yet", "STRATEGIC", "LOW", "DE", "2026-09-01",
     [("SUP-FRA-01", "SHIP_FROM", "RM Sensorik Offenbach", "Sprendlinger Landstrasse 115", "Offenbach am Main", "HE", "63069")],
     "rm-sensorik.example.de", "sensors", []),
]
FIRST = ['Olivia', 'Ethan', 'Hana', 'Mateo', 'Grace', 'Noah', 'Aiko', 'Diego', 'Freya', 'Omar', 'Mei', 'Lucas', 'Ingrid', 'Ravi', 'Chloe', 'Kofi', 'Elena', 'Samuel', 'Yuki', 'Ahmed', 'Sara', 'Viktor', 'Nadia', 'Joon', 'Clara', 'Tariq', 'Paula', 'Henrik', 'Anya', 'Bruno', 'Lea', 'Dmitri', 'Imani', 'Felix']
LAST = ['Novak', 'Sato', 'Okoye', 'Brennan', 'Castillo', 'Lindgren', 'Park', 'Duarte', 'Hoffmann', 'Rahman', 'Kovacs', 'Nguyen', 'Walsh', 'Tanaka', 'Moreau', 'Silva', 'Iyer', 'Kowalczyk', 'Fischer', 'Chandra', 'Ortiz', 'Byrne', 'Wong', 'Petrov']
PHONE = {'US': '+1-555-01{:02d}', 'CN': '+86-755-5550-{:04d}', 'MY': '+60-4-555-{:04d}', 'VN': '+84-28-5555-{:04d}', 'JP': '+81-75-555-{:04d}',
         'KR': '+82-31-555-{:04d}', 'PL': '+48-58-555-{:04d}', 'HU': '+36-1-555-{:04d}', 'IE': '+353-61-555-{:03d}', 'BR': '+55-19-5555-{:04d}',
         'CA': '+1-905-555-01{:02d}', 'TH': '+66-38-555-{:03d}', 'SG': '+65-6555-{:04d}', 'MX': '+52-662-555-{:04d}', 'DE': '+49-69-555-{:04d}'}
cnt = len(srm['contacts'])
DUNS = set(s['duns'] for s in srm['suppliers'])
for code, legal, trading, status, reason, tier, risk, cc, onboard, sites, domain, cat, plants in NEW_SUPPLIERS:
    duns = None
    while not duns or duns in DUNS:
        duns = f"{random.randint(10000000, 99999999):09d}"
    DUNS.add(duns)
    srm['suppliers'].append({"supplier_code": code, "erp_vendor_number": "0000710" + code[-3:], "legal_name": legal, "trading_name": trading,
        "status": status, "status_reason": reason, "tier": tier, "risk_rating": risk, "country": cc, "duns": duns,
        "portal_enabled": status != 'BLOCKED' and cc not in ('JP',), "asn_enabled": status == 'ACTIVE', "onboarded_on": onboard})
    for (sc, st, name, a1, city, region, zipc) in sites:
        srm['sites'].append({"site_code": sc, "supplier_code": code, "site_type": st, "name": name, "address_line1": a1, "city": city,
            "region": region, "postal_code": zipc, "country": cc, "active": status != 'BLOCKED'})
    roles = ['PRIMARY', 'LOGISTICS'] + random.sample(['QUALITY', 'FINANCE'], k=random.choice([0, 1, 1, 2]))
    for role in roles:
        cnt += 1
        fn, ln = random.choice(FIRST), random.choice(LAST)
        email = {'LOGISTICS': 'logistics', 'FINANCE': 'ar', 'QUALITY': 'quality'}.get(role, f"{fn.lower()}.{ln.lower()}")
        srm['contacts'].append({"contact_id": f"CNT-{cnt:04d}", "supplier_code": code, "role": role, "full_name": f"{fn} {ln}",
            "email": f"{email}@{domain}", "phone": PHONE[cc].format(random.randint(10, 99 if '{:02d}' in PHONE[cc] else 999))})

srm['entitlements'] += [
    {"consumer_id": "keystone-edi-gateway", "display_name": "Keystone Cable - AS2 EDI Gateway", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100812"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-SUP-100812", "contact_email": "edi@keystonecable.example.com"},
    {"consumer_id": "brightwave-portal", "display_name": "Brightwave Opto - Supplier Portal", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100845"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-SUP-100845", "contact_email": "it@brightwave-opto.example.cn"},
    {"consumer_id": "pst-b2b-api", "display_name": "Penang Semicon Test - B2B API", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100859"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-SUP-100859", "contact_email": "b2b@pst-semicon.example.my"},
    {"consumer_id": "hanbit-portal", "display_name": "Hanbit Display - Portal (read only)", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100884"], "scopes": ["supplier-orders.read"], "active": True, "cost_center": "EXT-SUP-100884", "contact_email": "scm@hanbit-display.example.kr"},
    {"consumer_id": "asia-pacific-edi-network", "display_name": "APAC Supplier EDI Network (multi-supplier VAN)", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100866", "SUP-100957", "SUP-100962", "SUP-100871"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-VAN-APAC", "contact_email": "onboarding@apac-edi-network.example.com"},
    {"consumer_id": "europe-supplier-hub", "display_name": "Europe Supplier Hub (multi-supplier)", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100903", "SUP-100917", "SUP-100926"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-HUB-EU", "contact_email": "support@eu-supplier-hub.example.com"},
    {"consumer_id": "americas-supplier-portal", "display_name": "Americas Supplier Portal", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100944", "SUP-100975", "SUP-100989", "SUP-100938"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": True, "cost_center": "EXT-PORTAL-AMER", "contact_email": "portal-support@jabil.example.com"},
    {"consumer_id": "tristar-portal", "display_name": "Tri-Star Surplus Portal (revoked)", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100951"], "scopes": ["supplier-orders.read"], "active": False, "cost_center": "EXT-SUP-100951", "contact_email": "it@tristar-surplus.example.com"},
    {"consumer_id": "rm-sensorik-onboarding", "display_name": "RM Sensorik - Integration (pending activation)", "consumer_type": "supplier-partner", "supplier_codes": ["SUP-100996"], "scopes": ["supplier-orders.read", "supplier-orders.write"], "active": False, "cost_center": "EXT-SUP-100996", "contact_email": "it@rm-sensorik.example.de"},
    {"consumer_id": "jabil-logistics-control-tower", "display_name": "Jabil Logistics Control Tower", "consumer_type": "internal-application", "supplier_codes": ["*"], "scopes": ["supplier-orders.read"], "active": True, "cost_center": "CC-4460-LOG", "contact_email": "control-tower@jabil.example.com"},
    {"consumer_id": "jabil-spend-analytics", "display_name": "Jabil Spend Analytics", "consumer_type": "internal-application", "supplier_codes": ["*"], "scopes": ["supplier-orders.read"], "active": True, "cost_center": "CC-4480-FIN", "contact_email": "spend-analytics@jabil.example.com"},
    {"consumer_id": "jabil-l2-support-desk", "display_name": "Supplier Platform L2 Support Desk", "consumer_type": "operations-support", "supplier_codes": ["*"], "scopes": ["supplier-orders.read"], "active": True, "cost_center": "CC-4420-SCO", "contact_email": "supplier-platform-l2@jabil.example.com"},
]

# ─── Materials catalog per category (material, text, uom, usd price) ────
CAT = {
    'cable': [("MAT-812010", "Wire harness, 18 AWG, 32-circuit", "EA", 14.80), ("MAT-812024", "Coaxial cable assembly, RG-316", "EA", 6.35), ("MAT-812031", "Power cord, IEC C13, 2 m", "EA", 3.10), ("MAT-812047", "Flat flex cable, 0.5 mm pitch", "EA", 0.95)],
    'opto': [("MAT-845110", "LED backlight module, 7 in", "EA", 9.40), ("MAT-845126", "Optocoupler, 4-pin SMD", "EA", 0.18), ("MAT-845133", "Fiber transceiver, SFP+ 10G", "EA", 24.50)],
    'semis': [("MAT-859201", "Microcontroller, 32-bit ARM, LQFP-64", "EA", 3.85), ("MAT-859214", "Power MOSFET, 60 V, D2PAK", "EA", 0.62), ("MAT-859228", "DC-DC converter IC, 3 A", "EA", 1.47), ("MAT-859236", "EEPROM, 256 Kbit, SOIC-8", "EA", 0.29)],
    'plastics': [("MAT-866301", "Injection-molded bezel, PC/ABS", "EA", 1.12), ("MAT-866315", "Battery door, PBT, black", "EA", 0.34), ("MAT-866322", "Light pipe, clear PC", "EA", 0.21)],
    'passives': [("MAT-871401", "Ceramic substrate, 96% alumina", "EA", 2.75), ("MAT-871418", "MLCC, 10 uF 25 V, 0805, reel", "RL", 38.00), ("MAT-871425", "Ceramic resonator, 16 MHz", "EA", 0.12)],
    'display': [("MAT-884501", "TFT LCD panel, 10.1 in, 1280x800", "EA", 41.20), ("MAT-884517", "Capacitive touch sensor, 10.1 in", "EA", 18.60), ("MAT-884523", "Cover glass, chemically strengthened", "EA", 5.90)],
    'metal': [("MAT-903601", "Stamped steel chassis, zinc plated", "EA", 4.30), ("MAT-903614", "Aluminum die-cast housing", "EA", 12.75), ("MAT-903628", "EMI shield can, nickel silver", "EA", 0.48), ("MAT-903635", "Mounting bracket, stainless 304", "EA", 0.86)],
    'magnetics': [("MAT-917701", "Power inductor, 10 uH, 5 A", "EA", 0.54), ("MAT-917712", "Common-mode choke, 2 x 1 mH", "EA", 0.91), ("MAT-917726", "Planar transformer, 500 W", "EA", 7.80)],
    'thermal': [("MAT-926801", "Heat pipe assembly, 6 mm", "EA", 5.60), ("MAT-926815", "Thermal interface pad, 3 W/mK", "EA", 0.38), ("MAT-926822", "Axial fan, 80 mm, 12 V", "EA", 3.95)],
    'pcba': [("MAT-938901", "PCBA, I/O expansion board", "EA", 22.40), ("MAT-938915", "PCBA, LED driver board", "EA", 8.70)],
    'fasteners': [("MAT-944010", "Machine screw, M3 x 8, Torx, box/1000", "BX", 18.50), ("MAT-944023", "PEM nut, M4, box/1000", "BX", 42.00), ("MAT-944037", "Standoff, M3 x 12, hex, box/500", "BX", 36.80)],
    'connectors': [("MAT-962110", "Board-to-board connector, 60-pin", "EA", 0.74), ("MAT-962124", "RJ45 jack with magnetics", "EA", 1.35), ("MAT-962131", "USB-C receptacle, 24-pin", "EA", 0.41), ("MAT-962145", "Terminal block, 5.08 mm, 4-way", "EA", 0.33)],
    'sensors': [("MAT-996201", "Pressure sensor, 0-10 bar", "EA", 16.20)],
}
QTY_BY_UOM = {'EA': [100, 200, 250, 300, 400, 500, 600, 750, 1000, 1200, 1500, 2000, 2500, 3000, 5000], 'RL': [10, 20, 25, 40, 50], 'BX': [5, 10, 12, 20, 25]}

# ─── Carriers ──────────────────────────────────────────────────────────
tms['carriers'] += [
    {"carrier_code": "SAIA", "scac": "SAIA", "name": "Saia LTL Freight", "mode": "LTL", "tracking_url_template": None},
    {"carrier_code": "ESTES", "scac": "EXLA", "name": "Estes Express Lines", "mode": "LTL", "tracking_url_template": None},
    {"carrier_code": "EXPEDITORS", "scac": "EXDO", "name": "Expeditors International", "mode": "AIR", "tracking_url_template": None},
    {"carrier_code": "KUEHNE", "scac": "KHNN", "name": "Kuehne+Nagel", "mode": "AIR", "tracking_url_template": None},
    {"carrier_code": "CMACGM", "scac": "CMDU", "name": "CMA CGM", "mode": "OCEAN", "tracking_url_template": None},
    {"carrier_code": "SCHENKER", "scac": "SHKK", "name": "DB Schenker Road", "mode": "FTL", "tracking_url_template": None},
]
REGION = {'US': 'NA', 'CA': 'NA', 'MX': 'NA', 'BR': 'SA', 'DE': 'EU', 'HU': 'EU', 'PL': 'EU', 'IE': 'EU', 'CN': 'AS', 'MY': 'AS', 'VN': 'AS', 'JP': 'AS', 'KR': 'AS', 'TH': 'AS', 'SG': 'AS', 'TW': 'AS', 'IN': 'AS'}
CITY_HUB = {'US': 'Louisville, KY, US', 'CA': 'Toronto, ON, CA', 'MX': 'Laredo, TX, US', 'DE': 'Frankfurt, HE, DE', 'HU': 'Budapest, BU, HU', 'PL': 'Warsaw, MZ, PL',
            'IE': 'Dublin, D, IE', 'CN': 'Shanghai, SH, CN', 'MY': 'Penang, PNG, MY', 'VN': 'Ho Chi Minh City, HCM, VN', 'JP': 'Osaka, OS, JP', 'KR': 'Incheon, IC, KR',
            'TH': 'Laem Chabang, CB, TH', 'SG': 'Singapore, SG', 'BR': 'Campinas, SP, BR', 'TW': 'Taipei, TP, TW', 'IN': 'Bengaluru, KA, IN'}

def pick_carrier(o, d, heavy):
    ro, rd = REGION[o], REGION[d]
    if o == d:
        return random.choice(['UPSN', 'FDEG', 'XPOL', 'ODFL', 'SAIA', 'EXLA']) if o in ('US',) else random.choice(['DHLE', 'SHKK'] if ro == 'EU' else ['DHLE'])
    if ro == rd == 'NA':
        return random.choice(['XPOL', 'ODFL', 'EXLA', 'SAIA'])
    if ro == rd == 'EU':
        return random.choice(['SHKK', 'DHLE'])
    if ro == rd == 'AS':
        return random.choice(['DHLE', 'KHNN', 'EXDO'])
    return random.choice(['MAEU', 'CMDU']) if heavy else random.choice(['DHLE', 'EXDO', 'KHNN'])

def tracking(scac, n):
    return {'UPSN': f"1Z999AA1{n:010d}", 'FDEG': f"7712{n:08d}", 'DHLE': f"JD01460{n:08d}", 'MAEU': f"MAEU{n:010d}", 'CMDU': f"CMDU{n:010d}"}.get(scac, f"{scac}{n:09d}")

# ─── Purchase orders + follow-on documents ────────────────────────────
SUPP = {s['supplier_code']: s for s in srm['suppliers']}
SITES = {}
for st in srm['sites']:
    if st['site_type'] in ('SHIP_FROM', 'MANUFACTURING') and st['supplier_code'] not in SITES:
        SITES[st['supplier_code']] = st
conf_no = 7100000020
del_no = 180000122
shp_suffix = [n for n in range(122, 200) if n != 188]
asn_counter = 440100
po_no = 4500123469
events_pending = []

def loc_from_site(st):
    return {"locationCode": st['site_code'], "name": st['name'], "street": st['address_line1'], "city": st['city'], "state": st['region'], "zip": st['postal_code'], "country": st['country']}

def loc_from_plant(p):
    return {"locationCode": p['site_code'], "name": p['name'], "street": p['street'], "city": p['city'], "state": p['region'], "zip": p['postal_code'], "country": p['country']}

def make_shipment(sup, po, lines, planned, eta, milestone, asn, created, exc_reason=None, cancel_reason=None):
    """lines: list of (item, qty)."""
    site = SITES[sup['supplier_code']]
    plant = PLANTS[po['plant']]
    total_units = sum(q for _, q in lines)
    heavy = total_units >= 1500
    scac = pick_carrier(site['country'], plant['country'], heavy)
    n = random.randint(10000000, 99999999)
    hu_type = 'PLT' if total_units >= 400 else 'CTN'
    hus = []
    for h in range(max(1, min(6, total_units // 600 + 1))):
        w = round(random.uniform(90, 320) if hu_type == 'PLT' else random.uniform(4, 28), 1)
        hus.append({"huId": f"{'PALLET' if hu_type == 'PLT' else 'CTN'}-{asn[-5:]}-{h + 1:02d}", "type": hu_type, "weight": {"value": w, "unit": 'lb' if site['country'] == 'US' and random.random() < 0.5 else 'kg'}})
    sid = f"SHP-{created.strftime('%Y%m%d')}-{shp_suffix.pop(0):05d}"
    origin_city = f"{site['city']}, {site['country']}"
    dest_city = f"{plant['city']}, {plant['country']}"
    ev = []
    if milestone != 'PLN':
        ev.append(("TND", "ASN received and tendered to carrier", None, created))
    since = created
    if milestone in ('ITR', 'EXC', 'DLV') or (milestone == 'CXL' and False):
        pu = planned + dt.timedelta(hours=random.randint(1, 10))
        ev.append(("PU", "Picked up by carrier", origin_city, pu))
        dep = pu + dt.timedelta(hours=random.randint(4, 20))
        ev.append(("DEP", "Departed origin facility", origin_city, dep))
        mid = dep + (eta - dep) * 0.55
        hub = CITY_HUB.get(plant['country'] if REGION[site['country']] != REGION[plant['country']] else site['country'], dest_city)
        if mid < TODAY:
            ev.append(("ARR", "Arrived at hub", hub, mid))
        since = pu
        if milestone == 'EXC':
            t = min(TODAY - dt.timedelta(hours=random.randint(3, 40)), max(mid, dep) + dt.timedelta(hours=6))
            ev.append(("EXC", exc_reason, hub, t))
            since = t
        if milestone == 'DLV':
            ofd = eta - dt.timedelta(hours=random.randint(3, 8))
            ev.append(("OFD", "Out for delivery", dest_city, ofd))
            dlv = eta + dt.timedelta(hours=random.randint(-3, 20))
            ev.append(("DLV", f"Delivered - received at dock by {plant['site_code']}", dest_city, dlv))
            since = dlv
    if milestone == 'TND':
        since = created
    if milestone == 'CXL':
        t = created + dt.timedelta(minutes=2)
        ev.append(("CXL", f"Cancelled: {cancel_reason}", None, t))
        since = t
    ev = [e for e in ev if e[3] <= TODAY - dt.timedelta(minutes=30)]
    if milestone in ('ITR', 'EXC') and not any(e[0] == 'PU' for e in ev):
        raise SystemExit(f'bad schedule {asn}')
    updated = max([e[3] for e in ev], default=created)
    contents = [{"poNumber": po['po_number'], "poLine": int(it['item_no']), "quantity": {"value": q, "uom": it['uom']}, "lotNumber": f"LOT-{random.randint(10000, 99999)}"} for it, q in lines]
    tms['shipments'].append({
        "shipment_id": sid, "asn_number": asn, "supplier_code": sup['supplier_code'], "carrier_scac": scac, "tracking_id": tracking(scac, n) if milestone != 'PLN' else None,
        "milestone": milestone, "milestone_since": iso(since), "origin": loc_from_site(site), "destination": loc_from_plant(plant),
        "planned_ship_at": iso(planned), "eta": iso(eta), "contents": contents, "handling_units": hus,
        "cancel_reason": cancel_reason, "created_at": iso(created), "updated_at": iso(updated),
        "events": [{"event_code": c, "description": d, "location": l, "occurred_at": iso(t)} for c, d, l, t in ev],
    })
    return sid

EXC_REASONS = ["Held at customs - HS code query", "Weather delay at hub", "Carrier capacity shortfall - rolled to next departure",
               "Address correction required at destination", "Damaged pallet - re-wrap at hub", "Port congestion - vessel delayed"]

orders_plan = []
for code, *_rest in NEW_SUPPLIERS:
    plants = _rest[-1]
    n = 0 if not plants else (random.randint(4, 5) if SUPP[code]['tier'] == 'STRATEGIC' else random.randint(2, 4))
    if code == 'SUP-100951':
        n = 3
    orders_plan += [code] * n
# a few extra orders for the original suppliers so their lists are richer
orders_plan += ['SUP-100245'] * 3 + ['SUP-100311'] * 2 + ['SUP-100402'] * 2 + ['SUP-100733'] * 2 + ['SUP-100518'] * 1
EXTRA_PLANTS = {'SUP-100245': ['1101', '1102', '1103'], 'SUP-100311': ['3101', '3102', '3103'], 'SUP-100402': ['4101', '4102', '4103'],
                'SUP-100733': ['4101', '4104', '4102'], 'SUP-100518': ['1101']}
EXTRA_CAT = {'SUP-100245': 'pcba', 'SUP-100311': 'connectors', 'SUP-100402': 'pcba', 'SUP-100733': 'passives', 'SUP-100518': 'plastics'}
random.shuffle(orders_plan)
SUP_META = {x[0]: x for x in NEW_SUPPLIERS}

for code in orders_plan:
    sup = SUPP[code]
    if code in SUP_META:
        cat, plants = SUP_META[code][11], SUP_META[code][12]
    else:
        cat, plants = EXTRA_CAT[code], EXTRA_PLANTS[code]
    plant = random.choice(plants)
    org = PLANT_ORG[plant]
    ccy = ORG_CCY[org]
    doc = TODAY - dt.timedelta(days=int(random.triangular(1, 80, 14)))
    doc = doc.replace(hour=random.randint(7, 17), minute=random.randint(0, 59), second=random.randint(0, 59))
    lead = random.randint(14, 55)
    deliv = doc + dt.timedelta(days=lead)
    mats = random.sample(CAT[cat], k=min(len(CAT[cat]), random.choice([1, 1, 2, 2, 3])))
    items = []
    for i, (mat, txt, uom, usd) in enumerate(mats):
        items.append({"item_no": f"{(i + 1) * 10:05d}", "material": mat, "short_text": txt, "quantity": random.choice(QTY_BY_UOM[uom]),
                      "uom": uom, "net_price": round(usd * CCY_FX[ccy] * random.uniform(0.96, 1.05), 2)})
    # choose lifecycle
    age = (TODAY - doc).days
    if sup['status'] == 'BLOCKED':
        life = random.choice(['CLOSED', 'CANCELLED', 'CANCELLED_RJ'])
    elif sup['status'] == 'ON_HOLD':
        life = random.choice(['OPEN', 'PARTIAL', 'CONFIRMED'])
    elif deliv < TODAY - dt.timedelta(days=12):
        life = random.choice(['CLOSED', 'CLOSED', 'DELIVERED', 'DELIVERED_PARTIAL', 'CANCELLED'])
    elif age < 4:
        life = random.choice(['OPEN', 'OPEN', 'OPEN', 'REJECTED_OPEN'])
    else:
        life = random.choices(['OPEN', 'PARTIAL', 'CONFIRMED', 'CONFIRMED_DRAFT_ASN', 'IN_TRANSIT', 'TENDERED', 'EXCEPTION', 'COMPENSATED', 'DELIVERED'],
                              weights=[12, 8, 12, 5, 22, 9, 7, 3, 8])[0]
    revision = 1 if random.random() < 0.7 else 2
    buyer = random.choice(ORG_BUYERS[org])
    inc, pay = ORG_TERMS[org]
    po = {"po_number": f"{po_no:010d}", "vendor_id": sup['erp_vendor_number'], "purch_org": org, "doc_date": day(doc), "currency": ccy,
          "status_code": "01", "delivery_date": day(deliv), "plant": plant, "incoterms": inc, "payment_terms": pay, "buyer_name": buyer,
          "revision": revision, "created_at": iso(doc), "changed_at": iso(doc), "items": items}
    po_no += 1
    changed = doc

    def confirm(category, status, qtys, dates, when, rejects=None):
        global conf_no
        erp['confirmations'].append({"confirmation_no": str(conf_no), "po_number": po['po_number'], "po_revision": revision, "conf_category": category,
            "vendor_reference": f"{sup['trading_name'].split()[0].upper()[:4]}-OC-{random.randint(10000, 99999)}",
            "note": {"AB": random.choice([None, "Confirmed as ordered.", "All lines confirmed."]), "AC": random.choice(["Partial allocation - balance to follow.", "Revised dates due to component lead time.", "Quantity limited by capacity."]), "RJ": random.choice(["Unable to supply - material end of life.", "Pricing not accepted.", "Capacity fully booked for the quarter."])}[category],
            "status": status, "posted_at": iso(when),
            "items": [{"item_no": it['item_no'], "confirmed_qty": f"{q:.3f}", "confirmed_date": sapd(dd) if dd else None, "reject_reason": (rejects or {}).get(it['item_no'])} for it, q, dd in zip(items, qtys, dates)]})
        for it, q, dd in zip(items, qtys, dates):
            it['confirmed_qty'] = q
            it['confirmed_date'] = day(dd) if dd else None
            if rejects and rejects.get(it['item_no']):
                it['reject_reason'] = rejects[it['item_no']]
        conf_no += 1

    conf_when = doc + dt.timedelta(days=random.randint(1, 3), hours=random.randint(0, 8))
    if conf_when > TODAY - dt.timedelta(hours=2):
        conf_when = TODAY - dt.timedelta(hours=random.randint(2, 20))
    full = [it['quantity'] for it in items]
    ddates = [deliv for _ in items]

    if life == 'OPEN':
        pass
    elif life == 'REJECTED_OPEN' or life == 'CANCELLED_RJ':
        confirm('RJ', 'POSTED', [0] * len(items), [None] * len(items), conf_when, {it['item_no']: random.choice(['EOL_MATERIAL', 'PRICE', 'CAPACITY']) for it in items})
        changed = conf_when
        if life == 'CANCELLED_RJ':
            po['status_code'] = '09'
            changed = conf_when + dt.timedelta(days=1)
            po['revision'] = revision + 1
    elif life == 'CANCELLED':
        po['status_code'] = '09'
        changed = doc + dt.timedelta(days=random.randint(1, 6))
        po['revision'] = revision + 1
    elif life == 'PARTIAL':
        qs = [q if i == 0 else round(q * random.choice([0, 0.5, 0.6])) for i, q in enumerate(full)] if len(items) > 1 else [round(full[0] * 0.6)]
        confirm('AC', 'IN_REVIEW', qs, [deliv + dt.timedelta(days=random.randint(0, 9)) if q else None for q in qs], conf_when,
                {it['item_no']: 'ALLOCATION' for it, q in zip(items, qs) if q == 0})
        po['status_code'] = '02'
        changed = conf_when
    else:
        # fully confirmed; some AC with a later date
        if random.random() < 0.3:
            dd = [deliv + dt.timedelta(days=random.randint(2, 7)) for _ in items]
            confirm('AC', 'IN_REVIEW' if random.random() < 0.3 and life in ('CONFIRMED',) else 'POSTED', full, dd, conf_when)
        else:
            dd = ddates
            confirm('AB', 'POSTED', full, dd, conf_when)
        po['status_code'] = '03'
        changed = conf_when
        ship_life = life
        if ship_life in ('CONFIRMED_DRAFT_ASN', 'IN_TRANSIT', 'TENDERED', 'EXCEPTION', 'COMPENSATED', 'DELIVERED', 'DELIVERED_PARTIAL', 'CLOSED'):
            # decide shipped quantities and shipment schedule
            transit = dt.timedelta(days=random.randint(2, 6) if REGION[SITES[code]['country']] == REGION[PLANTS[plant]['country']] else random.randint(6, 24))
            if ship_life in ('DELIVERED', 'DELIVERED_PARTIAL') and age < 12:
                ship_life = 'IN_TRANSIT'
            if ship_life in ('IN_TRANSIT', 'EXCEPTION') and age < 7:
                ship_life = 'TENDERED'
            if ship_life in ('DELIVERED', 'CLOSED', 'DELIVERED_PARTIAL'):
                eta = min(deliv, TODAY - dt.timedelta(days=random.randint(2, 6)))
                planned = max(eta - transit, conf_when + dt.timedelta(days=1))
                if planned > eta - dt.timedelta(days=1):
                    eta = planned + dt.timedelta(days=2)
                ms = 'DLV'
            elif ship_life in ('IN_TRANSIT', 'EXCEPTION'):
                back = random.randint(2, max(2, min(transit.days, age - 4)))
                planned = TODAY - dt.timedelta(days=back, hours=random.randint(0, 12))
                eta = planned + transit
                if eta < TODAY + dt.timedelta(hours=6):
                    eta = TODAY + dt.timedelta(days=random.randint(1, 4))
                ms = 'ITR' if ship_life == 'IN_TRANSIT' else 'EXC'
            else:
                planned = TODAY + dt.timedelta(days=random.randint(1, 5), hours=random.randint(0, 10))
                eta = planned + transit
                ms = {'CONFIRMED_DRAFT_ASN': 'PLN', 'TENDERED': 'TND', 'COMPENSATED': 'CXL'}[ship_life]
            planned = planned.replace(minute=0, second=0, microsecond=0)
            eta = eta.replace(minute=0, second=0, microsecond=0)
            created = min(planned - dt.timedelta(hours=random.randint(6, 30)), TODAY - dt.timedelta(hours=random.randint(1, 40), minutes=random.randint(0, 59)))
            if created < conf_when:
                created = conf_when + dt.timedelta(hours=2)
                if created > planned:
                    planned = (created + dt.timedelta(hours=3)).replace(minute=0, second=0, microsecond=0)
            if ship_life == 'DELIVERED_PARTIAL' or (ship_life in ('IN_TRANSIT', 'EXCEPTION', 'TENDERED') and random.random() < 0.35):
                lines = [(it, round(it['quantity'] * random.choice([0.4, 0.5, 0.6]))) for it in items[:max(1, len(items) - 1)]]
            else:
                lines = [(it, it['quantity']) for it in items]
            asn_counter += random.randint(3, 40)
            asn = f"ASN-{asn_counter}"
            sid = make_shipment(sup, po, lines, planned, eta, ms, asn, created,
                                exc_reason=random.choice(EXC_REASONS) if ms == 'EXC' else None,
                                cancel_reason="Compensation: ERP inbound delivery posting failed (saga rollback)" if ms == 'CXL' else None)
            if ms in ('TND', 'ITR', 'EXC', 'DLV', 'CXL'):
                erp['inbound_deliveries'].append({"delivery_no": str(del_no), "vendor_id": sup['erp_vendor_number'], "asn_reference": asn,
                    "status": 'REVERSED' if ms == 'CXL' else 'POSTED', "posted_at": iso(created + dt.timedelta(minutes=1)),
                    "reversed_at": iso(created + dt.timedelta(minutes=3)) if ms == 'CXL' else None,
                    "items": [{"po_number": po['po_number'], "item_no": it['item_no'], "quantity": f"{q:.3f}"} for it, q in lines]})
                del_no += 1
                if ms != 'CXL':
                    for it, q in lines:
                        it['shipped_qty'] = it.get('shipped_qty', 0) + q
                    po['status_code'] = '04'
                changed = max(changed, created)
            if ship_life == 'CLOSED':
                po['status_code'] = '05'
                changed = eta + dt.timedelta(days=random.randint(1, 3))
                po['revision'] = revision + 1
    po['changed_at'] = iso(min(changed, TODAY - dt.timedelta(minutes=30)))
    erp['purchase_orders'].append(po)

assert conf_no <= 7100000100, conf_no
assert del_no <= 180000200, del_no
for f, d in (('erp.json', erp), ('srm.json', srm), ('tms.json', tms)):
    (ROOT / f).write_text(json.dumps(d, indent=2, ensure_ascii=False) + '\n')

from collections import Counter
print('suppliers', len(srm['suppliers']), 'sites', len(srm['sites']), 'contacts', len(srm['contacts']), 'entitlements', len(srm['entitlements']))
print('plants', len(erp['plants']), 'orgs', len(erp['purchasing_orgs']), 'POs', len(erp['purchase_orders']), Counter(p['status_code'] for p in erp['purchase_orders']))
print('confirmations', len(erp['confirmations']), 'deliveries', len(erp['inbound_deliveries']))
print('carriers', len(tms['carriers']), 'shipments', len(tms['shipments']), Counter(s['milestone'] for s in tms['shipments']))
print('events', sum(len(s['events']) for s in tms['shipments']))
