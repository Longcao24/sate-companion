#!/usr/bin/env python3
"""Build SATE_System_Test_Linked.xlsx — the test workbook with the tables actually joined.

The original workbook had the right sheets but no relationships: every requirement's
"Linked Test Cases" column read 0, the Summary counts were typed-in constants that went
stale the moment anyone ran a test, and the Defect Log had no connection to a test case
beyond a free-text ID.

What "connected" means here, concretely:

  Requirements  ←→  Test Cases        many-to-many, resolved through a real join sheet
  Traceability      the join table itself — one row per (requirement, test case) pair,
                    with the test case's live status pulled across
  Defect Log    →   Test Cases        validated dropdown + lookups for title/priority/
                                      category/requirements, so a defect cannot name a
                                      test case that does not exist
  Summary       →   Test Cases        every figure is a formula; nothing is typed
  Lists         →   everywhere        one controlled vocabulary drives every dropdown

Split of responsibility, deliberately:
  * STATIC relationships (which requirement covers which case) are written as real values.
    They cannot break, and they are correct in any spreadsheet application.
  * STATUS-DERIVED figures (how many passed, which requirements are still uncovered) are
    formulas, because Status is the one column that changes while a test run is underway.

    python3 build_workbook.py
"""

import json
import re
from collections import defaultdict
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule, FormulaRule

HERE = Path(__file__).parent
CASES = json.loads(Path('/tmp/cases.json').read_text())
RAW = json.loads(Path('/tmp/tc.json').read_text())
OUT = Path('/Users/longcao/Desktop/SATE/sate-companion/doc/testdata/SATE_System_Test_Linked.xlsx')

# ---------------------------------------------------------------------------
# Palette — the SATE design system tokens, so the workbook matches the product.
# ---------------------------------------------------------------------------
BLUE = '2563EB'
BLUE_SOFT = 'EFF6FF'
GREY_SOFT = 'F9FAFB'
LINE = 'E5E7EB'
OK_SOFT, OK_TEXT = 'F0FDF4', '15803D'
WARN_SOFT, WARN_TEXT = 'FFFBEB', 'B45309'
BAD_SOFT, BAD_TEXT = 'FEF2F2', 'B91C1C'

HEAD_FILL = PatternFill('solid', fgColor=BLUE)
HEAD_FONT = Font(color='FFFFFF', bold=True, size=10, name='Calibri')
TITLE_FONT = Font(bold=True, size=16, color='111827')
SUB_FONT = Font(size=10, color='6B7280', italic=True)
MONO = Font(name='Consolas', size=10)
BOLD = Font(bold=True, size=10)
BODY = Font(size=10)
THIN = Side(style='thin', color=LINE)
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
TOP_WRAP = Alignment(vertical='top', wrap_text=True)
TOP = Alignment(vertical='top')
CENTER = Alignment(horizontal='center', vertical='center')

# Requirements whose expected behaviour nobody has decided yet — a case that depends on
# one of these can only be recorded, not passed or failed.
UNSETTLED = ['RQ-05', 'RQ-06', 'RQ-07', 'RQ-09', 'RQ-11',
             'RQ-12', 'RQ-13', 'RQ-15', 'RQ-20', 'RQ-21']

STATUSES = ['Not Run', 'Pass', 'Fail', 'Blocked', 'Skipped']
SEVERITIES = ['Release Blocker', 'Critical', 'Major', 'Minor', 'Cosmetic']
DEFECT_STATES = ['Open', 'In Progress', 'Fixed', 'Verified', 'Reopened', "Won't Fix"]

# ---------------------------------------------------------------------------
# Pull requirements and environment out of the original workbook
# ---------------------------------------------------------------------------
def rows_of(sheet, ncols):
    out = []
    for _rid, row in RAW[sheet][1:]:
        out.append([row.get(get_column_letter(i + 1), '') for i in range(ncols)])
    return out

SCOPE_DEF = json.loads(
    Path('/Users/longcao/Desktop/SATE/sate-companion/doc/testdata/test-scope.json').read_text())
SCOPE = SCOPE_DEF['scope']
REDUCED, RUNNOTE, DEFNOTE = (SCOPE_DEF['reduced_note'], SCOPE_DEF['run_note'],
                             SCOPE_DEF['deferral_note'])

def scope_of(tid):
    return SCOPE.get(tid, 'In scope')

def scope_note(tid):
    return REDUCED.get(tid) or RUNNOTE.get(tid) or DEFNOTE.get(tid) or ''

def running(tid):
    return not scope_of(tid).startswith('Deferred')

SIDE_DEF = json.loads(
    Path('/Users/longcao/Desktop/SATE/sate-companion/doc/testdata/test-side.json').read_text())
SIDE = SIDE_DEF['side']
ACCESS = SIDE_DEF['access']
RUN_BY = SIDE_DEF['run_by']
EXTRA = SIDE_DEF['extra_access']
USER_ACTION = SIDE_DEF['user_action']

def access_for(tid):
    base = ACCESS[SIDE[tid]]
    return f"{base} · {EXTRA[tid]}" if tid in EXTRA else base

REQS = rows_of('Requirements', 5)          # ID, Topic, Status, Definition, (old link col)
ENV = rows_of('Environment & Test Data', 3)

# Server-side notes, lifted from the generated markdown so the workbook and the doc
# cannot disagree.
MD = Path('/Users/longcao/Desktop/SATE/sate-companion/doc/13-system-test.md').read_text()
SERVER = {}
for c in CASES:
    m = re.search(r'^### ' + re.escape(c['TC ID']) + r' .*?^> \*\*Server side\.\*\*\n(.*?)(?=\n\n\| Result)',
                  MD, re.S | re.M)
    if m:
        text = ' '.join(l[2:].strip() for l in m.group(1).split('\n') if l.strip('> ').strip())
        SERVER[c['TC ID']] = re.sub(r'\s+', ' ', text).replace('`', '').strip()

# ---------------------------------------------------------------------------
# The join: requirement  ↔  test case
# ---------------------------------------------------------------------------
req_to_tc = defaultdict(list)
pairs = []
for c in CASES:
    for r in [x.strip() for x in c['Requirement IDs'].split(',') if x.strip()]:
        req_to_tc[r].append(c['TC ID'])
        pairs.append((r, c['TC ID']))

req_meta = {r[0]: (r[1], r[2]) for r in REQS}
known_reqs = set(req_meta)
orphan_reqs = sorted({r for r, _ in pairs} - known_reqs)   # referenced but not defined

wb = Workbook()

# ===========================================================================
def header(ws, headers, widths, row=1, freeze=None):
    for i, (h, w) in enumerate(zip(headers, widths), 1):
        cell = ws.cell(row=row, column=i, value=h)
        cell.fill, cell.font, cell.border = HEAD_FILL, HEAD_FONT, BOX
        cell.alignment = Alignment(vertical='center', wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[row].height = 30
    if freeze:
        ws.freeze_panes = freeze


def write(ws, r, values, wrap_cols=(), font=BODY):
    for i, v in enumerate(values, 1):
        cell = ws.cell(row=r, column=i, value=v)
        cell.border = BOX
        cell.font = font
        cell.alignment = TOP_WRAP if i in wrap_cols else TOP


# ===========================================================================
# 1. Read Me
# ===========================================================================
ws = wb.active
ws.title = 'Read Me'
ws.sheet_view.showGridLines = False
ws.column_dimensions['A'].width = 3
ws.column_dimensions['B'].width = 30
ws.column_dimensions['C'].width = 104

ws['B2'] = 'SATE System Test — linked workbook'
ws['B2'].font = TITLE_FONT
ws['B3'] = 'Every table is joined to the others. Nothing here is a typed-in number.'
ws['B3'].font = SUB_FONT

readme = [
    ('', ''),
    ('HOW THE SHEETS CONNECT', ''),
    ('Requirements ↔ Test Cases',
     'Many-to-many. A test case lists its requirements in "Requirement IDs"; a requirement lists '
     'its cases in "Linked Test Cases". Both directions are written as real values, so they are '
     'correct in any spreadsheet application.'),
    ('Traceability',
     f'The join table itself — one row per (requirement, test case) pair, {len(pairs)} rows. This is '
     'the sheet to filter when you need "everything covering RQ-11" or "every requirement this '
     'case touches". The test case status column pulls live from Test Cases.'),
    ('Defect Log → Test Cases',
     'The Test Case ID column is a dropdown restricted to real IDs, so a defect cannot reference '
     'a case that does not exist. Title, Category, Priority and Requirement IDs then fill in by '
     'lookup — you type the ID and nothing else.'),
    ('Test Cases → Defect Log',
     'The "Defects" column counts matching rows in the Defect Log, so a case shows its open '
     'defects without you cross-referencing by hand.'),
    ('Summary → Test Cases',
     'Every figure is a formula over the Test Cases sheet. Change one Status and the whole '
     'summary moves. The original workbook had these as constants, which went stale the moment '
     'anyone ran a test.'),
    ('Lists',
     'One controlled vocabulary drives every dropdown in the workbook. Edit it there, not in '
     'the sheets that use it.'),
    ('', ''),
    ('WHAT IS A FORMULA AND WHAT IS DATA', ''),
    ('Data (safe, permanent)',
     'Which requirement covers which case. These relationships do not change during a test run, '
     'so they are stored as values and cannot break.'),
    ('Formulas (live)',
     'Anything derived from Status — pass counts, coverage, blockers. Status is the one column '
     'that changes while you are testing, so these must recalculate.'),
    ('', ''),
    ('HOW TO RUN IT', ''),
    ('1. Settle the blocked requirements',
     'Ten requirements are still "Needs confirmation" or "Partially defined". A case depending on '
     'one cannot pass or fail — mark it Blocked and record what you saw. The "Blocked By" column '
     'on Test Cases flags them for you.'),
    ('2. Filter to P0 and work down',
     '65 of 88 cases are P0. A failed P0 is a release blocker by default.'),
    ('3. Fill Status, then the rest',
     'Status is the only column the summary depends on. Actual Result, Evidence and Defect ID are '
     'for the record.'),
    ('4. Raise defects in the Defect Log',
     'Pick the Test Case ID from the dropdown; the rest fills itself in.'),
    ('', ''),
    ('BEFORE YOU TOUCH A DEVICE', ''),
    ('Check the system is up',
     'Run "sate infra" in hwtest/ — it probes auth, database, device-api including the v15 verify '
     'route, Storage, the Cloudflare worker, the AI queue and device heartbeat. Half of a failed '
     'test run is a service that was already down.'),
    ('Use a unique session label',
     'Say it aloud at the start and end of every recording. It is the only way to prove a '
     'transcript belongs to the audio you think it does.'),
    ('', ''),
    ('COMPANION DOCUMENT', ''),
    ('doc/13-system-test.md',
     'The same 88 cases written as step-by-step instructions, each with a server-side note naming '
     'the actual table, route and constant to check. The "Server-Side Check" column here is a '
     'condensed version of those notes.'),
]
r = 5
for label, text in readme:
    if label and not text:
        ws.cell(row=r, column=2, value=label).font = Font(bold=True, size=11, color=BLUE)
        r += 1
        continue
    if not label:
        r += 1
        continue
    c1 = ws.cell(row=r, column=2, value=label)
    c1.font = BOLD
    c1.alignment = TOP_WRAP
    c2 = ws.cell(row=r, column=3, value=text)
    c2.font = BODY
    c2.alignment = TOP_WRAP
    ws.row_dimensions[r].height = max(15, 13 * (len(text) // 100 + 1))
    r += 1

# ===========================================================================
# 2. Lists — the controlled vocabulary everything else validates against
# ===========================================================================
ls = wb.create_sheet('Lists')
CATS = sorted({c['Category'] for c in CASES})
TYPES = sorted({c['Test Type'] for c in CASES})
cols = [('Status', STATUSES), ('Priority', ['P0', 'P1', 'P2']),
        ('Test Side', ['End User', 'Server Side', 'Both']), ('Severity', SEVERITIES),
        ('Defect Status', DEFECT_STATES), ('Category', CATS), ('Test Type', TYPES),
        ('Requirement Status', ['Required', 'Needs confirmation', 'Partially defined']),
        ('Scope', ['In scope', 'In scope (reduced)', 'Deferred - mobile app',
                   'Deferred - pendant / BLE'])]
header(ls, [c[0] for c in cols], [16, 10, 14, 18, 15, 46, 26, 20, 26], freeze='A2')
for ci, (_name, vals) in enumerate(cols, 1):
    for ri, v in enumerate(vals, 2):
        cell = ls.cell(row=ri, column=ci, value=v)
        cell.border, cell.font = BOX, BODY

# ===========================================================================
# 3. Test Cases
# ===========================================================================
tc = wb.create_sheet('Test Cases')
TC_HEAD = ['TC ID', 'Scope', 'Scope Note', 'Test Side', 'Run By', 'Access Needed', 'Category', 'Test Case Title',
           'Priority', 'Test Type', 'Requirement IDs',
           'Req Count', 'Blocked By', 'Components', 'Objective', 'Preconditions',
           'Test Data / Environment', 'Test Steps', 'Expected Device / App / Web Result',
           'Expected Backend / Data Result', 'Server-Side Check', 'Data Integrity / Validation',
           'Pass Criteria', 'Status', 'Actual Result', 'Defects', 'Defect ID',
           'Evidence / Notes', 'Executed By', 'Executed On']
TC_W = [15, 22, 52, 13, 16, 46, 30, 44, 9, 20, 20, 10, 22, 34, 42, 42, 34, 46, 46, 46, 58, 42, 42,
        12, 34, 9, 14, 34, 14, 13]
header(tc, TC_HEAD, TC_W, freeze='I2')

for i, c in enumerate(CASES, start=2):
    reqs = [x.strip() for x in c['Requirement IDs'].split(',') if x.strip()]
    blocked = [r for r in reqs if r in UNSETTLED]
    tid = c['TC ID']
    write(tc, i, [
        tid, scope_of(tid), scope_note(tid), SIDE[tid], RUN_BY[SIDE[tid]], access_for(tid),
        c['Category'], c['Test Case Title'], c['Priority'], c['Test Type'],
        ', '.join(reqs), len(reqs),
        ', '.join(blocked) if blocked else '',
        c['Components'], c['Objective'], c['Preconditions'], c['Test Data / Environment'],
        c['Test Steps'], c['Expected Device / App / Web Result'],
        c['Expected Backend / Data Result'], SERVER.get(c['TC ID'], ''),
        c['Data Integrity / Validation'], c['Pass Criteria'],
        'Not Run', '',
        # Live link into the Defect Log: how many defects name this case.
        f"=COUNTIF('Defect Log'!$C$2:$C$500,$A{i})",
        '', '', '', '',
    ], wrap_cols=set(range(14, 24)) | {3, 6, 8, 11, 13})
    tc.cell(row=i, column=1).font = MONO
    tc.cell(row=i, column=4).alignment = CENTER
    tc.cell(row=i, column=12).alignment = CENTER
    tc.cell(row=i, column=26).alignment = CENTER
    if not running(tid):
        # A deferred row is greyed out: still readable, obviously not part of this run.
        for col in range(1, len(TC_HEAD) + 1):
            tc.cell(row=i, column=col).font = Font(size=10, color='9CA3AF', italic=True)
    tc.row_dimensions[i].height = 58

last = len(CASES) + 1
tc.auto_filter.ref = f'A1:AD{last}'

dv_status = DataValidation(type='list', formula1='=Lists!$A$2:$A$6', allow_blank=True,
                           showDropDown=False)
dv_status.error = 'Pick a status from the list.'
dv_status.errorTitle = 'Invalid status'
tc.add_data_validation(dv_status)
dv_status.add(f'X2:X{last}')

dv_scope = DataValidation(type='list', formula1='=Lists!$H$2:$H$5', allow_blank=True,
                          showDropDown=False)
tc.add_data_validation(dv_scope)
dv_scope.add(f'B2:B{last}')

# Colour the whole row by outcome — a failed P0 has to be visible from across the room.
tc.conditional_formatting.add(f'A2:AB{last}', FormulaRule(
    formula=[f'AND($X2="Fail",$I2="P0")'],
    fill=PatternFill('solid', fgColor='FECACA'), font=Font(color=BAD_TEXT, bold=True, size=10)))
tc.conditional_formatting.add(f'A2:AB{last}', FormulaRule(
    formula=[f'$X2="Fail"'], fill=PatternFill('solid', fgColor=BAD_SOFT), font=Font(color=BAD_TEXT, size=10)))
tc.conditional_formatting.add(f'A2:AB{last}', FormulaRule(
    formula=[f'$X2="Pass"'], fill=PatternFill('solid', fgColor=OK_SOFT)))
tc.conditional_formatting.add(f'A2:AB{last}', FormulaRule(
    formula=[f'$X2="Blocked"'], fill=PatternFill('solid', fgColor=WARN_SOFT)))
# Cases held up by an undecided requirement.
tc.conditional_formatting.add(f'M2:M{last}', FormulaRule(
    formula=['LEN($M2)>0'], fill=PatternFill('solid', fgColor=WARN_SOFT), font=Font(color=WARN_TEXT, size=10)))
tc.conditional_formatting.add(f'I2:I{last}', CellIsRule(
    operator='equal', formula=['"P0"'], font=Font(color=BAD_TEXT, bold=True, size=10)))

tc.conditional_formatting.add(f'B2:C{last}', FormulaRule(
    formula=['LEFT($B2,8)="Deferred"'], fill=PatternFill('solid', fgColor='F3F4F6'),
    font=Font(color='6B7280', italic=True, size=10)))
tc.conditional_formatting.add(f'B2:B{last}', FormulaRule(
    formula=['$B2="In scope (reduced)"'], fill=PatternFill('solid', fgColor=WARN_SOFT),
    font=Font(color=WARN_TEXT, size=10)))
tc.conditional_formatting.add(f'D2:E{last}', FormulaRule(
    formula=['$D2="End User"'], fill=PatternFill('solid', fgColor='EFF6FF'),
    font=Font(color='1D4ED8', bold=True, size=10)))
tc.conditional_formatting.add(f'D2:E{last}', FormulaRule(
    formula=['$D2="Server Side"'], fill=PatternFill('solid', fgColor='F3F4F6'),
    font=Font(color='374151', bold=True, size=10)))
tc.conditional_formatting.add(f'D2:E{last}', FormulaRule(
    formula=['$D2="Both"'], fill=PatternFill('solid', fgColor='FFFBEB'),
    font=Font(color=WARN_TEXT, bold=True, size=10)))

# ===========================================================================
# 4. Requirements — now with real links back to the cases
# ===========================================================================
rq = wb.create_sheet('Requirements')
RQ_HEAD = ['Requirement ID', 'Topic', 'Definition Status', 'Definition / Decision Needed',
           'Linked Test Cases', 'Cases', 'P0 Cases', 'Passed', 'Failed', 'Blocked',
           'Not Run', 'Coverage']
header(rq, RQ_HEAD, [16, 30, 20, 92, 46, 8, 9, 9, 9, 9, 9, 20], freeze='B2')

for i, (rid, topic, status, definition, _old) in enumerate(REQS, start=2):
    tcs = req_to_tc.get(rid, [])
    p0 = sum(1 for t in tcs if next(c['Priority'] for c in CASES if c['TC ID'] == t) == 'P0')
    # SEARCH across the comma-separated Requirement IDs column. IDs are zero-padded to two
    # digits (RQ-01 … RQ-22), so no ID is a prefix of another and a substring match is safe.
    def count(status_value):
        return (f"=SUMPRODUCT(--ISNUMBER(SEARCH($A{i},'Test Cases'!$K$2:$K${last}))"
                f",--('Test Cases'!$X$2:$X${last}=\"{status_value}\"))")
    write(rq, i, [
        rid, topic, status, definition,
        ', '.join(tcs) if tcs else '— no test case references this —',
        len(tcs), p0,
        count('Pass'), count('Fail'), count('Blocked'), count('Not Run'),
        f'=IF($F{i}=0,"UNCOVERED",IF($H{i}=$F{i},"Complete",'
        f'IF($I{i}>0,"Failing",IF($H{i}+$I{i}+$J{i}=0,"Not started","In progress"))))',
    ], wrap_cols={2, 4, 5})
    rq.cell(row=i, column=1).font = MONO
    for col in range(6, 12):
        rq.cell(row=i, column=col).alignment = CENTER
    rq.row_dimensions[i].height = 46

rq_last = len(REQS) + 1
rq.auto_filter.ref = f'A1:L{rq_last}'
rq.conditional_formatting.add(f'C2:C{rq_last}', CellIsRule(
    operator='equal', formula=['"Needs confirmation"'],
    fill=PatternFill('solid', fgColor=WARN_SOFT), font=Font(color=WARN_TEXT, bold=True, size=10)))
rq.conditional_formatting.add(f'C2:C{rq_last}', CellIsRule(
    operator='equal', formula=['"Partially defined"'],
    fill=PatternFill('solid', fgColor=WARN_SOFT), font=Font(color=WARN_TEXT, size=10)))
rq.conditional_formatting.add(f'L2:L{rq_last}', CellIsRule(
    operator='equal', formula=['"UNCOVERED"'],
    fill=PatternFill('solid', fgColor=BAD_SOFT), font=Font(color=BAD_TEXT, bold=True, size=10)))
rq.conditional_formatting.add(f'L2:L{rq_last}', CellIsRule(
    operator='equal', formula=['"Failing"'],
    fill=PatternFill('solid', fgColor=BAD_SOFT), font=Font(color=BAD_TEXT, bold=True, size=10)))
rq.conditional_formatting.add(f'L2:L{rq_last}', CellIsRule(
    operator='equal', formula=['"Complete"'],
    fill=PatternFill('solid', fgColor=OK_SOFT), font=Font(color=OK_TEXT, bold=True, size=10)))

# ===========================================================================
# 5. Traceability — the join table
# ===========================================================================
tr = wb.create_sheet('Traceability')
header(tr, ['Requirement ID', 'Requirement Topic', 'Definition Status', 'Test Case ID',
            'Test Case Title', 'Category', 'Priority', 'Test Case Status'],
       [16, 30, 20, 15, 46, 32, 9, 15], freeze='A2')

by_id = {c['TC ID']: c for c in CASES}
row = 2
for rid, tid in sorted(pairs, key=lambda p: (p[0], p[1])):
    c = by_id[tid]
    topic, dstatus = req_meta.get(rid, ('(not defined in Requirements)', 'MISSING'))
    write(tr, row, [
        rid, topic, dstatus, tid, c['Test Case Title'], c['Category'], c['Priority'],
        # Live status, pulled across so the join table reflects the current run.
        f"=IFERROR(VLOOKUP($D{row},'Test Cases'!$A:$X,24,FALSE),\"\")",
    ], wrap_cols={2, 5, 6})
    tr.cell(row=row, column=1).font = MONO
    tr.cell(row=row, column=4).font = MONO
    tr.cell(row=row, column=7).alignment = CENTER
    row += 1

tr_last = row - 1
tr.auto_filter.ref = f'A1:H{tr_last}'
tr.conditional_formatting.add(f'A2:H{tr_last}', FormulaRule(
    formula=['$H2="Fail"'], fill=PatternFill('solid', fgColor=BAD_SOFT)))
tr.conditional_formatting.add(f'A2:H{tr_last}', FormulaRule(
    formula=['$H2="Pass"'], fill=PatternFill('solid', fgColor=OK_SOFT)))
tr.conditional_formatting.add(f'C2:C{tr_last}', CellIsRule(
    operator='equal', formula=['"MISSING"'],
    fill=PatternFill('solid', fgColor=BAD_SOFT), font=Font(color=BAD_TEXT, bold=True, size=10)))

# ===========================================================================
# 6. Defect Log — validated against Test Cases, with lookups
# ===========================================================================
dl = wb.create_sheet('Defect Log')
DL_HEAD = ['Defect ID', 'Date Found', 'Test Case ID', 'Test Case Title', 'Category',
           'Priority', 'Requirement IDs', 'Severity', 'Status', 'Component', 'Summary',
           'Steps to Reproduce', 'Expected Result', 'Actual Result',
           'Session ID / Request IDs', 'Environment', 'Owner', 'Target Fix Version',
           'Retest Result', 'Evidence / Link']
header(dl, DL_HEAD, [13, 13, 15, 44, 30, 9, 20, 18, 15, 26, 44, 44, 40, 40, 26, 26, 16, 16, 16, 30],
       freeze='D2')

ROWS = 200
for i in range(2, ROWS + 2):
    # Type the Test Case ID and the rest arrives. IFERROR keeps empty rows clean rather
    # than filling the sheet with #N/A.
    write(dl, i, [
        '', '', '',
        f"=IFERROR(VLOOKUP($C{i},'Test Cases'!$A:$H,8,FALSE),\"\")",   # Title
        f"=IFERROR(VLOOKUP($C{i},'Test Cases'!$A:$G,7,FALSE),\"\")",   # Category
        f"=IFERROR(VLOOKUP($C{i},'Test Cases'!$A:$I,9,FALSE),\"\")",   # Priority
        f"=IFERROR(VLOOKUP($C{i},'Test Cases'!$A:$K,11,FALSE),\"\")",  # Requirement IDs
        '', 'Open', '', '', '', '', '', '', '', '', '', '', '',
    ], wrap_cols={4, 5, 7, 11, 12, 13, 14, 16, 20})
    dl.cell(row=i, column=3).font = MONO
    for col in (4, 5, 6, 7):
        dl.cell(row=i, column=col).font = Font(size=10, color='6B7280', italic=True)

dv_tc = DataValidation(type='list', formula1=f"='Test Cases'!$A$2:$A${last}",
                       allow_blank=True, showDropDown=False)
dv_tc.error = 'Pick a Test Case ID that exists on the Test Cases sheet.'
dv_tc.errorTitle = 'Unknown test case'
dl.add_data_validation(dv_tc)
dv_tc.add(f'C2:C{ROWS + 1}')

dv_sev = DataValidation(type='list', formula1='=Lists!$D$2:$D$6', allow_blank=True, showDropDown=False)
dl.add_data_validation(dv_sev)
dv_sev.add(f'H2:H{ROWS + 1}')

dv_dstat = DataValidation(type='list', formula1='=Lists!$E$2:$E$7', allow_blank=True, showDropDown=False)
dl.add_data_validation(dv_dstat)
dv_dstat.add(f'I2:I{ROWS + 1}')

dl.auto_filter.ref = f'A1:T{ROWS + 1}'
dl.conditional_formatting.add(f'A2:T{ROWS + 1}', FormulaRule(
    formula=['$H2="Release Blocker"'], fill=PatternFill('solid', fgColor=BAD_SOFT),
    font=Font(color=BAD_TEXT, bold=True, size=10)))
dl.conditional_formatting.add(f'I2:I{ROWS + 1}', CellIsRule(
    operator='equal', formula=['"Verified"'], fill=PatternFill('solid', fgColor=OK_SOFT),
    font=Font(color=OK_TEXT, size=10)))

# ===========================================================================
# 6b. Scope sheets — one per role.
#
# Not duplicates of Test Cases: they are indexes. Each lists only the cases that role can
# actually execute, with the status pulled live from Test Cases so a scope sheet is never
# out of date. Fill Status on Test Cases; read progress here.
# ===========================================================================
def scope_sheet(title, sides, blurb):
    sh = wb.create_sheet(title)
    sh.sheet_view.showGridLines = False
    sh['A1'] = title
    sh['A1'].font = TITLE_FONT
    sh['A2'] = blurb
    sh['A2'].font = SUB_FONT
    sh.merge_cells('A2:G2')
    header(sh, ['TC ID', 'Priority', 'Category', 'Test Case Title', 'Scope Note',
                'Blocked By', 'Status'],
           [15, 9, 30, 50, 52, 20, 12], row=4, freeze='A5')
    rr = 5
    picked = [c for c in CASES if SIDE[c['TC ID']] in sides and running(c['TC ID'])]
    # P0 first, then by ID — the order they should actually be run in.
    picked.sort(key=lambda c: (c['Priority'], c['TC ID']))
    for c in picked:
        tid = c['TC ID']
        blocked = ', '.join(r.strip() for r in c['Requirement IDs'].split(',')
                            if r.strip() in UNSETTLED)
        write(sh, rr, [
            tid, c['Priority'], c['Category'], c['Test Case Title'], scope_note(tid), blocked,
            f"=IFERROR(VLOOKUP($A{rr},'Test Cases'!$A:$X,24,FALSE),\"\")",
        ], wrap_cols={3, 4, 5})
        sh.cell(row=rr, column=1).font = MONO
        sh.cell(row=rr, column=2).alignment = CENTER
        sh.cell(row=rr, column=7).alignment = CENTER
        sh.row_dimensions[rr].height = 30
        rr += 1
    end = rr - 1
    sh.auto_filter.ref = f'A4:G{end}'
    sh.conditional_formatting.add(f'A5:G{end}', FormulaRule(
        formula=['$G5="Fail"'], fill=PatternFill('solid', fgColor=BAD_SOFT),
        font=Font(color=BAD_TEXT, size=10)))
    sh.conditional_formatting.add(f'A5:G{end}', FormulaRule(
        formula=['$G5="Pass"'], fill=PatternFill('solid', fgColor=OK_SOFT)))
    sh.conditional_formatting.add(f'A5:G{end}', FormulaRule(
        formula=['$G5="Blocked"'], fill=PatternFill('solid', fgColor=WARN_SOFT)))
    sh.conditional_formatting.add(f'B5:B{end}', CellIsRule(
        operator='equal', formula=['"P0"'], font=Font(color=BAD_TEXT, bold=True, size=10)))
    sh.conditional_formatting.add(f'F5:F{end}', FormulaRule(
        formula=['LEN($F5)>0'], fill=PatternFill('solid', fgColor=WARN_SOFT),
        font=Font(color=WARN_TEXT, size=10)))
    return len(picked)

n_user = scope_sheet(
    'End-User Tests', {'End User', 'Both'},
    'Everything a tester performs, IN THE CURRENT SCOPE — the mobile app and pendant are '
    'excluded. "Both" cases are listed here too: you run them, but an engineer has to confirm '
    'the result on the server before they can be marked Pass.')
n_server = scope_sheet(
    'Server-Side Tests', {'Server Side', 'Both'},
    'Everything needing backend access, IN THE CURRENT SCOPE. "Both" cases are listed here '
    'too — the tester performs the action, you verify it. Pure Server Side cases you drive '
    'entirely yourself.')

dfr = wb.create_sheet('Deferred (out of scope)')
dfr.sheet_view.showGridLines = False
dfr['A1'] = 'Deferred — not part of this run'
dfr['A1'].font = TITLE_FONT
dfr['A2'] = ('The mobile app and the pendant are not being tested right now. These cases are '
             'parked, not deleted — put them back by editing doc/testdata/test-scope.json.')
dfr['A2'].font = SUB_FONT
dfr.merge_cells('A2:F2')
header(dfr, ['TC ID', 'Priority', 'Category', 'Test Case Title', 'Deferred because',
             'Why it is safe to defer'], [15, 9, 32, 50, 24, 78], row=4, freeze='A5')
rr = 5
for c in sorted((c for c in CASES if not running(c['TC ID'])),
                key=lambda c: (c['Priority'], c['TC ID'])):
    tid = c['TC ID']
    why = DEFNOTE.get(tid, '')
    if not why:
        why = ('The mobile app is not in scope.' if 'mobile app' in scope_of(tid)
               else 'The pendant / BLE accessory is not in scope.')
    write(dfr, rr, [tid, c['Priority'], c['Category'], c['Test Case Title'],
                    scope_of(tid).replace('Deferred - ', ''), why], wrap_cols={3, 4, 6})
    dfr.cell(row=rr, column=1).font = MONO
    dfr.cell(row=rr, column=2).alignment = CENTER
    dfr.row_dimensions[rr].height = 30
    rr += 1
dfr.auto_filter.ref = f'A4:F{rr - 1}'
dfr.conditional_formatting.add(f'B5:B{rr - 1}', CellIsRule(
    operator='equal', formula=['"P0"'], font=Font(color=BAD_TEXT, bold=True, size=10)))

# The coverage cost of deferring, stated rather than left to be discovered.
gap = SCOPE_DEF['coverage_impact']['requirements_losing_all_coverage']
rr += 2
dfr.cell(row=rr, column=1, value='COVERAGE LOST BY DEFERRING').font = Font(bold=True, size=11, color=BAD_TEXT)
rr += 1
for g in gap:
    c1 = dfr.cell(row=rr, column=1, value=g['id'])
    c1.font = Font(name='Consolas', size=10, bold=True, color=BAD_TEXT)
    c2 = dfr.cell(row=rr, column=2, value=f"{g['topic']} [{g['definition_status']}] — {g['note']}")
    c2.font, c2.alignment = BODY, TOP_WRAP
    dfr.merge_cells(start_row=rr, start_column=2, end_row=rr, end_column=6)
    dfr.row_dimensions[rr].height = 42
    rr += 1

# ===========================================================================
# 7. Environment & Test Data
# ===========================================================================
en = wb.create_sheet('Environment & Test Data')
header(en, ['Area', 'Test Item', 'Recommended Setup / Use', 'Ready?', 'Owner', 'Notes'],
       [26, 40, 88, 11, 16, 40], freeze='A2')
for i, (area, item, setup) in enumerate(ENV, start=2):
    write(en, i, [area, item, setup, 'No', '', ''], wrap_cols={2, 3, 6})
    en.row_dimensions[i].height = 32
en_last = len(ENV) + 1
dv_ready = DataValidation(type='list', formula1='"Yes,No,N/A"', allow_blank=True, showDropDown=False)
en.add_data_validation(dv_ready)
dv_ready.add(f'D2:D{en_last}')
en.auto_filter.ref = f'A1:F{en_last}'
en.conditional_formatting.add(f'D2:D{en_last}', CellIsRule(
    operator='equal', formula=['"Yes"'], fill=PatternFill('solid', fgColor=OK_SOFT),
    font=Font(color=OK_TEXT, bold=True, size=10)))
en.conditional_formatting.add(f'D2:D{en_last}', CellIsRule(
    operator='equal', formula=['"No"'], fill=PatternFill('solid', fgColor=WARN_SOFT),
    font=Font(color=WARN_TEXT, size=10)))

# ===========================================================================
# 8. Summary — every number a formula over Test Cases
# ===========================================================================
sm = wb.create_sheet('Summary', 1)
sm.sheet_view.showGridLines = False
for col, w in zip('ABCDEFGH', [3, 34, 13, 13, 13, 13, 13, 13]):
    sm.column_dimensions[col].width = w

sm['B2'] = 'SATE system test — live summary'
sm['B2'].font = TITLE_FONT
sm['B3'] = 'Every figure below is a formula over the Test Cases sheet. Change a Status and this moves.'
sm['B3'].font = SUB_FONT

S = f"'Test Cases'!$X$2:$X${last}"
P = f"'Test Cases'!$I$2:$I${last}"
C = f"'Test Cases'!$G$2:$G${last}"
H = f"'Test Cases'!$M$2:$M${last}"
SD = f"'Test Cases'!$D$2:$D${last}"
SC = f"'Test Cases'!$B$2:$B${last}"

def block(title, r):
    cell = sm.cell(row=r, column=2, value=title)
    cell.font = Font(bold=True, size=11, color=BLUE)
    return r + 1

r = block('EXECUTION', 5)
HEAD_ROW = r
sm.cell(row=r, column=2, value='Metric').font = HEAD_FONT
sm.cell(row=r, column=2).fill = HEAD_FILL
for j, h in enumerate(['Total', 'P0', 'P1', 'P2'], 3):
    c = sm.cell(row=r, column=j, value=h)
    c.font, c.fill, c.alignment = HEAD_FONT, HEAD_FILL, CENTER
r += 1
ROW_OF = {}
for label, status in [('Total cases', None), ('Not Run', 'Not Run'), ('Pass', 'Pass'),
                      ('Fail', 'Fail'), ('Blocked', 'Blocked'), ('Skipped', 'Skipped')]:
    ROW_OF[label] = r
    sm.cell(row=r, column=2, value=label).font = BOLD if status is None else BODY
    for j, pri in enumerate(['', 'P0', 'P1', 'P2'], 3):
        if status is None:
            f = f'=COUNTA({P})' if not pri else f'=COUNTIF({P},"{pri}")'
        elif not pri:
            f = f'=COUNTIF({S},"{status}")'
        else:
            f = f'=COUNTIFS({S},"{status}",{P},"{pri}")'
        c = sm.cell(row=r, column=j, value=f)
        c.alignment, c.border, c.font = CENTER, BOX, BODY
    r += 1

EXEC = f"C{ROW_OF['Pass']}+C{ROW_OF['Fail']}+C{ROW_OF['Blocked']}"
TOTAL = f"C{ROW_OF['Total cases']}"
sm.cell(row=r, column=2, value='Executed').font = BOLD
sm.cell(row=r, column=3, value=f'={EXEC}').alignment = CENTER
sm.cell(row=r, column=3).border = BOX
sm.cell(row=r + 1, column=2, value='Progress').font = BOLD
pc = sm.cell(row=r + 1, column=3, value=f'=IF({TOTAL}=0,0,({EXEC})/{TOTAL})')
pc.number_format = '0.0%'
pc.alignment, pc.border = CENTER, BOX
r += 3

r = block('RELEASE GATE', r)
sm.cell(row=r, column=2, value='P0 failures').font = BOLD
g = sm.cell(row=r, column=3, value=f'=COUNTIFS({S},"Fail",{P},"P0")')
g.alignment, g.border = CENTER, BOX
sm.cell(row=r, column=4, value='=IF(C{}=0,"CLEAR","BLOCKED")'.format(r)).font = Font(bold=True, size=10)
sm.cell(row=r, column=4).alignment = CENTER
sm.conditional_formatting.add(f'D{r}', CellIsRule(
    operator='equal', formula=['"BLOCKED"'], fill=PatternFill('solid', fgColor=BAD_SOFT),
    font=Font(color=BAD_TEXT, bold=True, size=10)))
sm.conditional_formatting.add(f'D{r}', CellIsRule(
    operator='equal', formula=['"CLEAR"'], fill=PatternFill('solid', fgColor=OK_SOFT),
    font=Font(color=OK_TEXT, bold=True, size=10)))
r += 1
sm.cell(row=r, column=2, value='Open defects').font = BODY
d = sm.cell(row=r, column=3, value="=COUNTIFS('Defect Log'!$I$2:$I$201,\"Open\")")
d.alignment, d.border = CENTER, BOX
r += 1
sm.cell(row=r, column=2, value='Release blockers logged').font = BODY
d = sm.cell(row=r, column=3, value="=COUNTIF('Defect Log'!$H$2:$H$201,\"Release Blocker\")")
d.alignment, d.border = CENTER, BOX
r += 1
sm.cell(row=r, column=2, value='Cases blocked by undecided requirements').font = BODY
d = sm.cell(row=r, column=3, value=f'=COUNTIF({H},"?*")')
d.alignment, d.border = CENTER, BOX
r += 3

r = block('SCOPE OF THIS RUN', r)
sm.cell(row=r, column=2, value='Mobile app and pendant are OUT of scope. Recorder, backend, '
        'web app and PDF are in.').font = SUB_FONT
sm.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
r += 1
for j, h in enumerate(['Scope', 'Cases', 'P0', 'Pass', 'Fail', 'Blocked', 'Not Run'], 2):
    c = sm.cell(row=r, column=j, value=h)
    c.font, c.fill = HEAD_FONT, HEAD_FILL
    c.alignment = CENTER if j > 2 else Alignment(vertical='center')
r += 1
for lbl in ['In scope', 'In scope (reduced)', 'Deferred - mobile app', 'Deferred - pendant / BLE']:
    sm.cell(row=r, column=2, value=lbl).font = BOLD
    sm.cell(row=r, column=2).border = BOX
    for j, f in enumerate([
        f'=COUNTIF({SC},$B{r})', f'=COUNTIFS({SC},$B{r},{P},"P0")',
        f'=COUNTIFS({SC},$B{r},{S},"Pass")', f'=COUNTIFS({SC},$B{r},{S},"Fail")',
        f'=COUNTIFS({SC},$B{r},{S},"Blocked")', f'=COUNTIFS({SC},$B{r},{S},"Not Run")',
    ], 3):
        c = sm.cell(row=r, column=j, value=f)
        c.alignment, c.border, c.font = CENTER, BOX, BODY
    r += 1
sm.cell(row=r, column=2, value='RUNNING THIS PASS').font = Font(bold=True, size=10, color=BLUE)
for j, f in enumerate([f'=C{r-4}+C{r-3}', f'=D{r-4}+D{r-3}'], 3):
    c = sm.cell(row=r, column=j, value=f)
    c.alignment, c.border, c.font = CENTER, BOX, Font(bold=True, size=10, color=BLUE)
r += 3

r = block('WHO RUNS WHAT', r)
for j, h in enumerate(['Test Side', 'Cases', 'P0', 'Pass', 'Fail', 'Blocked', 'Not Run'], 2):
    c = sm.cell(row=r, column=j, value=h)
    c.font, c.fill = HEAD_FONT, HEAD_FILL
    c.alignment = CENTER if j > 2 else Alignment(vertical='center')
r += 1
SIDE_NOTE = {
    'End User': 'Tester alone — recorder, phone, browser. No backend access needed.',
    'Both': 'User performs it; pass/fail needs a server check. Plan for two people.',
    'Server Side': 'Cannot be judged from the UI. Fault injection and queue inspection.',
}
for sd in ['End User', 'Both', 'Server Side']:
    sm.cell(row=r, column=2, value=sd).font = BOLD
    sm.cell(row=r, column=2).border = BOX
    for j, f in enumerate([
        f'=COUNTIF({SD},$B{r})',
        f'=COUNTIFS({SD},$B{r},{P},"P0")',
        f'=COUNTIFS({SD},$B{r},{S},"Pass")',
        f'=COUNTIFS({SD},$B{r},{S},"Fail")',
        f'=COUNTIFS({SD},$B{r},{S},"Blocked")',
        f'=COUNTIFS({SD},$B{r},{S},"Not Run")',
    ], 3):
        c = sm.cell(row=r, column=j, value=f)
        c.alignment, c.border, c.font = CENTER, BOX, BODY
    n = sm.cell(row=r, column=9, value=SIDE_NOTE[sd])
    n.font, n.alignment = SUB_FONT, TOP_WRAP
    r += 1
sm.column_dimensions['I'].width = 62
r += 2

r = block('BY CATEGORY', r)
for j, h in enumerate(['Category', 'Cases', 'P0', 'Pass', 'Fail', 'Blocked', 'Not Run'], 2):
    c = sm.cell(row=r, column=j, value=h)
    c.font, c.fill = HEAD_FONT, HEAD_FILL
    c.alignment = CENTER if j > 2 else Alignment(vertical='center')
r += 1
for cat in sorted({c['Category'] for c in CASES}):
    sm.cell(row=r, column=2, value=cat).font = BODY
    sm.cell(row=r, column=2).border = BOX
    cells = [
        f'=COUNTIF({C},$B{r})',
        f'=COUNTIFS({C},$B{r},{P},"P0")',
        f'=COUNTIFS({C},$B{r},{S},"Pass")',
        f'=COUNTIFS({C},$B{r},{S},"Fail")',
        f'=COUNTIFS({C},$B{r},{S},"Blocked")',
        f'=COUNTIFS({C},$B{r},{S},"Not Run")',
    ]
    for j, f in enumerate(cells, 3):
        c = sm.cell(row=r, column=j, value=f)
        c.alignment, c.border, c.font = CENTER, BOX, BODY
    r += 1
r += 2

r = block('REQUIREMENTS', r)
sm.cell(row=r, column=2, value='Total requirements').font = BODY
sm.cell(row=r, column=3, value=f'=COUNTA(Requirements!$A$2:$A${rq_last})').alignment = CENTER
r += 1
sm.cell(row=r, column=2, value='Still undecided (needs confirmation / partial)').font = BODY
sm.cell(row=r, column=3,
        value=f'=COUNTIF(Requirements!$C$2:$C${rq_last},"Needs confirmation")'
              f'+COUNTIF(Requirements!$C$2:$C${rq_last},"Partially defined")').alignment = CENTER
r += 1
sm.cell(row=r, column=2, value='Uncovered by any test case').font = BODY
sm.cell(row=r, column=3, value=f'=COUNTIF(Requirements!$L$2:$L${rq_last},"UNCOVERED")').alignment = CENTER
r += 1
sm.cell(row=r, column=2, value='Requirements with a failing case').font = BODY
sm.cell(row=r, column=3, value=f'=COUNTIF(Requirements!$L$2:$L${rq_last},"Failing")').alignment = CENTER
r += 1
sm.cell(row=r, column=2, value='Requirement ↔ test case links (Traceability rows)').font = BODY
sm.cell(row=r, column=3, value=tr_last - 1).alignment = CENTER
r += 3

r = block('KNOWN DEFECTS — EXPECT THESE', r)
known = [
    ('SATE-SEC-005', 'POST /firmware is routed above the /admin gate — any authenticated user can push fleet-wide OTA.'),
    ('SATE-BE-008', 'The process-device-session copy in the repo is not the production no-op; deploying it duplicates every recording.'),
    ('SATE-E2E-006, SATE-QUE-006', 'Upload dedup relies on a probe with no database unique constraint behind it.'),
    ('SATE-LONG-002/003', "Storage's project-wide file size limit overrides the bucket's; a full take is ~118 MB."),
]
for tid, what in known:
    a = sm.cell(row=r, column=2, value=tid)
    a.font = Font(name='Consolas', size=9, color=BAD_TEXT, bold=True)
    a.alignment = TOP_WRAP
    b = sm.cell(row=r, column=3, value=what)
    b.font, b.alignment = BODY, TOP_WRAP
    sm.merge_cells(start_row=r, start_column=3, end_row=r, end_column=8)
    sm.row_dimensions[r].height = 26
    r += 1

OUT.parent.mkdir(parents=True, exist_ok=True)
wb.save(OUT)

print(f'wrote {OUT}')
print(f'  sheets      : {wb.sheetnames}')
print(f'  test cases  : {len(CASES)}')
print(f'  requirements: {len(REQS)}')
print(f'  RQ↔TC links : {tr_last - 1}')
print(f'  end-user    : {n_user} cases   server-side: {n_server} cases')
from collections import Counter as _C
_c = _C(SIDE.values())
print(f'  split       : End User {_c["End User"]} · Both {_c["Both"]} · Server Side {_c["Server Side"]}')
if orphan_reqs:
    print(f'  ⚠ referenced but not defined in Requirements: {orphan_reqs}')
uncovered = sorted(known_reqs - set(req_to_tc))
if uncovered:
    print(f'  ⚠ requirements with no test case: {uncovered}')
