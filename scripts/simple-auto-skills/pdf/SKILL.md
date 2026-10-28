---
name: pdf
description: 提取 PDF 文字与表格、合并/拆分/旋转/加密、生成 PDF 报告、填写表单；扫描件可 OCR。
---
# PDF

## 环境
```bash
python3 -c "import pypdf, pdfplumber; print('ok')"; python3 -c "import reportlab; print('reportlab ok')"
```
缺少时：`python3 -m venv .venv && .venv/bin/pip install -q pypdf pdfplumber reportlab`，之后用 `.venv/bin/python`。

## 提取文字与表格
```python
import pdfplumber
with pdfplumber.open("im-inputs/xxx/doc.pdf") as pdf:
    print(len(pdf.pages), "页")
    for i, page in enumerate(pdf.pages, 1):
        text = page.extract_text() or ""
        print(f"--- 第{i}页 ---\n{text}")
        for table in page.extract_tables():
            for row in table: print(row)
```
- 几乎提取不到文字说明是扫描件：有 `tesseract` 时用 OCR（`pdftoppm -r 200 -png in.pdf page` 后 `tesseract page-1.png - -l chi_sim+eng`），没有就如实告知。
- 长文档先报告页数和目录，再按用户关心的部分读取，不要一次把全文塞进回复。

## 合并、拆分、旋转、加密
```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for path in ["a.pdf", "b.pdf"]:
    for page in PdfReader(path).pages: w.add_page(page)
w.write("outbox/合并.pdf")

r = PdfReader("in.pdf"); w = PdfWriter()
for i in range(2, 5): w.add_page(r.pages[i])          # 第3–5页
w.write("outbox/节选.pdf")

r = PdfReader("in.pdf"); w = PdfWriter()
for p in r.pages: p.rotate(90); w.add_page(p)
w.encrypt("密码"); w.write("outbox/加密.pdf")
```

## 生成 PDF
- 已有 Word/PPT/Excel：优先用 LibreOffice 转换 `soffice --headless --convert-to pdf --outdir outbox 文件`。
- 从零生成报告用 reportlab；中文必须注册中文字体，否则显示为方块：
```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))   # 内置中文字体，无需字体文件
st = getSampleStyleSheet()
for name in ("Title", "Heading2", "BodyText"): st[name].fontName = "STSong-Light"
doc = SimpleDocTemplate("outbox/报告.pdf", pagesize=A4)
table = Table([["项目", "金额"], ["A", "100"]])
table.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), "STSong-Light"), ("GRID", (0, 0), (-1, -1), 0.5, colors.grey)]))
doc.build([Paragraph("报告标题", st["Title"]), Spacer(1, 12), Paragraph("正文……", st["BodyText"]), table])
```

## 填写表单
```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("form.pdf"); print(r.get_fields().keys())     # 先列出字段名
w = PdfWriter(); w.append(r)
w.update_page_form_field_values(w.pages[0], {"姓名": "张三"}, auto_regenerate=False)
w.set_need_appearances_writer(True)
w.write("outbox/已填写.pdf")
```
- 填中文时 pypdf 可能提示字体不支持：表单自带字体不含中文。已设置 `NeedAppearances`，大多数阅读器会用系统字体重新显示；交付时提醒用户用 Acrobat/预览打开核对。
- 没有可填字段（扫描版表单）时，告诉用户只能在页面上叠加文字，并确认后再做。

## 交付
结果保存到 `outbox/`，回复中说明页数、做了哪些处理。
