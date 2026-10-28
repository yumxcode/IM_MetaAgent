---
name: pptx
description: 读取和生成 PowerPoint 演示文稿（.pptx），含标题页、要点页、表格、图片、图表，并可导出 PDF。
---
# PPT 演示文稿（.pptx）

## 环境
```bash
python3 -c "import pptx; print('python-pptx ok')"
```
缺少时：`python3 -m venv .venv && .venv/bin/pip install -q python-pptx`，之后用 `.venv/bin/python`。

## 读取
```python
from pptx import Presentation
prs = Presentation("im-inputs/xxx/deck.pptx")
for i, slide in enumerate(prs.slides, 1):
    texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
    print(i, " / ".join(texts))
    if slide.has_notes_slide: print("  备注:", slide.notes_slide.notes_text_frame.text)
```

## 生成
先写大纲（每页一个结论式标题 + 3–5 个要点），再生成：
```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

prs = Presentation(); prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9
title_layout, content_layout, blank = prs.slide_layouts[0], prs.slide_layouts[1], prs.slide_layouts[6]

s = prs.slides.add_slide(title_layout)
s.shapes.title.text = "季度复盘"; s.placeholders[1].text = "2026 年第三季度"

s = prs.slides.add_slide(content_layout)
s.shapes.title.text = "收入增长 25%，主要来自新客户"
body = s.placeholders[1].text_frame; body.clear()
for i, line in enumerate(["新客户贡献 60%", "老客户续费率 92%", "成本增幅低于收入"]):
    p = body.paragraphs[0] if i == 0 else body.add_paragraph()
    p.text = line; p.font.size = Pt(24)

s = prs.slides.add_slide(blank)
data = CategoryChartData(); data.categories = ["7月", "8月", "9月"]; data.add_series("收入", (120, 150, 170))
s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1), Inches(11), Inches(5.5), data)

prs.save("outbox/季度复盘.pptx")
```
- 默认模板的占位符位置适合 4:3，改成 16:9 后若排版拥挤，用空白版式 + 文本框自行定位。
- 中文字体：给 run 设置 `font.name = "微软雅黑"`；部分查看器还需东亚字体，交付后可提示用户在 PowerPoint 中统一替换字体。
- 用户给了模板时，用 `Presentation(模板路径)` 并复用其版式，不要新建空白文档。
- 每页文字少而精，数字配图表；需要配图时先在工作区生成图片（如 matplotlib）再 `add_picture`。

## 导出 PDF / 预览
```bash
soffice --headless --convert-to pdf --outdir outbox outbox/季度复盘.pptx
```
没有 LibreOffice 时只交付 .pptx 并说明。

## 交付前检查
重新读取生成的文件，确认页数、标题、没有空白占位符（未填写的占位符要删除：`sp = ph._element; sp.getparent().remove(sp)`）。
