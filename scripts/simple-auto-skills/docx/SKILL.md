---
name: docx
description: 读取、生成和修改 Word 文档（.docx），含标题层级、表格、图片、页眉页脚，并可转 PDF。
---
# Word 文档（.docx）

## 先确认环境
```bash
python3 -c "import docx; print('python-docx ok')"
```
缺少时不要尝试全局安装（沙箱只能写工作区），在工作区建虚拟环境：
```bash
python3 -m venv .venv && .venv/bin/pip install -q python-docx && PY=.venv/bin/python
```
已安装则 `PY=python3`。

## 读取
- 只要文字：`markitdown 文件.docx`（若已安装）最快，保留标题和表格结构。
- 需要结构：
```python
from docx import Document
d = Document("in.docx")
for p in d.paragraphs:
    print(p.style.name, "|", p.text)
for t in d.tables:
    for row in t.rows:
        print([c.text for c in row.cells])
```

## 生成
```python
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

d = Document()
# 中文字体：同时设置西文和东亚字体，否则中文会回落到默认字体
style = d.styles["Normal"]
style.font.name = "宋体"; style.font.size = Pt(11)
style.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
for s in d.sections:
    s.left_margin = s.right_margin = Cm(2.5)

d.add_heading("标题", level=0)
d.add_heading("一、背景", level=1)
p = d.add_paragraph("正文内容。"); p.paragraph_format.first_line_indent = Pt(22)
d.add_paragraph("要点一", style="List Bullet")
t = d.add_table(rows=1, cols=3); t.style = "Table Grid"
for cell, text in zip(t.rows[0].cells, ["项目", "数量", "备注"]):
    cell.text = text
row = t.add_row().cells; row[0].text = "A"; row[1].text = "3"; row[2].text = ""
d.add_picture("chart.png", width=Cm(14))   # 图片需先在工作区生成
d.sections[0].header.paragraphs[0].text = "页眉文字"
d.save("outbox/报告.docx")
```
- 标题用 `add_heading`，目录才能识别层级。
- 文件名用中文可以，保存到 `outbox/` 下就会发回微信。

## 修改已有文档
- 保留原格式：逐段修改 `run.text`，不要直接给 `paragraph.text` 赋值（会丢掉加粗等格式）。
- 替换占位符时，占位符可能被拆在多个 run 里；先把段落 runs 文本拼起来判断，再合并到第一个 run。
- 用户发来的附件在 `im-inputs/` 下，修改后另存到 `outbox/`，不要覆盖原件。

## 转 PDF / 旧格式
```bash
soffice --headless --convert-to pdf --outdir outbox outbox/报告.docx
soffice --headless --convert-to docx --outdir . 旧文件.doc      # .doc → .docx 再处理
```
没有 LibreOffice（`command -v soffice` 为空）时如实告诉用户，只交付 .docx。

## 交付前检查
- 重新打开生成的文件读一遍文字，确认没有乱码、占位符已替换。
- 回复里简要说明做了什么，文件会随结果发送。
