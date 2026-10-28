---
name: xlsx
description: 读取、清洗、计算和生成 Excel 表格（.xlsx/.csv），含公式、格式、图表、多工作表。
---
# Excel 表格（.xlsx / .csv）

## 环境
```bash
python3 -c "import openpyxl, pandas; print('ok')"
```
缺少时在工作区建虚拟环境：`python3 -m venv .venv && .venv/bin/pip install -q openpyxl pandas`，之后用 `.venv/bin/python`。

## 读取与分析
```python
import pandas as pd
xl = pd.ExcelFile("im-inputs/xxx/data.xlsx")
print(xl.sheet_names)
df = pd.read_excel(xl, sheet_name=0, header=0)
print(df.shape); print(df.head(10).to_string()); print(df.dtypes)
```
- 先看表头所在行、合并单元格、空行，再决定 `header=` / `skiprows=`。
- 计算结果在回复里给出关键数字，并说明口径（筛选条件、是否去重）。
- 只读数值不读公式时：`openpyxl.load_workbook(p, data_only=True)`（返回上次保存时的计算结果，若文件从未在 Excel 中打开过可能为空）。

## 生成表格
```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference

wb = Workbook(); ws = wb.active; ws.title = "汇总"
rows = [("月份", "收入", "成本"), ("1月", 120, 80), ("2月", 150, 95)]
for r in rows: ws.append(r)
n = ws.max_row
ws.append(("合计", f"=SUM(B2:B{n})", f"=SUM(C2:C{n})"))      # 用公式而不是写死结果
ws["D1"] = "利润"
for i in range(2, ws.max_row + 1): ws[f"D{i}"] = f"=B{i}-C{i}"

head = Font(bold=True, color="FFFFFF"); fill = PatternFill("solid", fgColor="4472C4")
thin = Side(style="thin", color="BFBFBF")
for c in ws[1]: c.font = head; c.fill = fill; c.alignment = Alignment(horizontal="center")
for row in ws.iter_rows():
    for c in row: c.border = Border(top=thin, bottom=thin, left=thin, right=thin)
for col in range(1, ws.max_column + 1): ws.column_dimensions[get_column_letter(col)].width = 14
ws.freeze_panes = "A2"
for row in ws.iter_rows(min_row=2, min_col=2):
    for c in row: c.number_format = "#,##0.00"

chart = BarChart(); chart.title = "收入与成本"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_col=3, max_row=n), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=n))
ws.add_chart(chart, "F2")
wb.save("outbox/汇总.xlsx")
```
- 汇总、合计、比例尽量写成公式，用户改数据后会自动更新。
- openpyxl 不计算公式；需要在交付前核对公式结果时，用 LibreOffice 重算一份：
  `soffice --headless --convert-to xlsx --outdir /tmp/recalc outbox/汇总.xlsx`，再用 `data_only=True` 读取 `/tmp/recalc` 下的文件检查（`/tmp` 不可写时改用工作区子目录）。

## 修改已有表格
- `load_workbook(path)` 修改后另存到 `outbox/`，不覆盖用户原件。
- openpyxl 会丢失部分高级特性（数据透视表、宏、部分条件格式）。遇到 .xlsm 或透视表时先告诉用户可能受影响。

## CSV
- 中文 CSV 先试 `encoding="utf-8-sig"`，乱码再试 `gbk`。
- 交付给 Excel 打开的 CSV 用 `utf-8-sig` 编码，否则中文乱码。
