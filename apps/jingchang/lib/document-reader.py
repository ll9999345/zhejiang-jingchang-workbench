"""Bounded, local-only Office/text extraction. Never executes or extracts ZIP entries."""
import base64
import json
import io
import pathlib
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

TEXT_LIMIT = 12000
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'}
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'


def parse(file, kind, image_limit):
    raw = file if isinstance(file, bytes) else pathlib.Path(file).read_bytes()
    warnings, images = [], []
    result = {'kind': kind, 'encoding': '', 'images': images, 'imageCount': 0, 'sheetCount': 0, 'warnings': warnings}
    if kind == 'text':
        if b'\x00' in raw:
            raise ValueError('文字文件含二进制内容；请转存 UTF-8 文本')
        for encoding in ('utf-8-sig', 'utf-8', 'gb18030'):
            try:
                text = raw.decode(encoding)
                result['encoding'] = encoding
                break
            except UnicodeDecodeError:
                pass
        else:
            text = raw.decode('utf-8', errors='replace')
            result['encoding'] = 'utf-8-replacement'
            warnings.append('无法完整识别编码，部分字符已替换，请检查正文')
    else:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > 4096 or sum(x.file_size for x in entries) > 64 * 1024**2:
                raise ValueError('Office 文档展开后过大或文件数量过多')
            seen = set()
            for item in entries:
                name = item.filename
                if name in seen or '\\' in name or name.startswith('/') or '..' in name.split('/') or ':' in name or item.flag_bits & 1 or (item.external_attr >> 16) & 0o170000 == 0o120000 or item.file_size > 16 * 1024**2:
                    raise ValueError('Office 文档含不安全、重复、加密或过大的文件项')
                seen.add(name)

            def xml(name):
                raw = archive.read(name)
                # NUL removal also catches declarations in UTF-16/32 documents.
                upper = raw.replace(b'\x00', b'').upper()
                if b'<!DOCTYPE' in upper or b'<!ENTITY' in upper:
                    raise ValueError('文档不支持 DTD 或实体声明')
                return ET.fromstring(raw)

            if kind == 'docx':
                root = xml('word/document.xml')
                paragraphs = []
                for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
                    paragraphs.append(''.join((e.text or '') if e.tag.endswith('}t') else '\n' if e.tag.endswith('}br') or e.tag.endswith('}cr') else '\t' if e.tag.endswith('}tab') else '' for e in p.iter()))
                text = '\n'.join(paragraphs)
            elif kind == 'xlsx':
                strings = []
                if 'xl/sharedStrings.xml' in seen:
                    strings = [''.join(t.text or '' for t in item.iter(NS+'t')) for item in xml('xl/sharedStrings.xml').findall(NS+'si')]
                sheets = []
                if 'xl/workbook.xml' in seen and 'xl/_rels/workbook.xml.rels' in seen:
                    targets = {}
                    for item in xml('xl/_rels/workbook.xml.rels'):
                        if item.get('TargetMode') == 'External':
                            continue
                        target = item.get('Target', '')
                        target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/'+target)
                        if target.startswith('xl/worksheets/') and target in seen:
                            targets[item.get('Id')] = target
                    for sheet in xml('xl/workbook.xml').iter(NS+'sheet'):
                        if sheet.get(REL) in targets:
                            sheets.append((sheet.get('name', '工作表'), targets[sheet.get(REL)]))
                if not sheets:
                    sheets = [(name.rsplit('/', 1)[-1], name) for name in sorted(seen) if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name)]
                if not sheets:
                    raise ValueError('Excel 文档没有可读取的工作表')
                result['sheetCount'] = len(sheets)
                if len(sheets) > 8:
                    warnings.append('只读取前 8 张工作表')
                blocks = []
                for name, entry in sheets[:8]:
                    rows = []
                    for row in xml(entry).iter(NS+'row'):
                        cells = []
                        for cell in row.findall(NS+'c'):
                            value = cell.findtext(NS+'v', '')
                            kind_ = cell.get('t')
                            if kind_ == 's':
                                value = strings[int(value)] if value.isdigit() and int(value) < len(strings) else ''
                            elif kind_ == 'inlineStr':
                                value = ''.join(t.text or '' for t in cell.iter(NS+'t'))
                            elif kind_ == 'b':
                                value = 'TRUE' if value == '1' else 'FALSE'
                            formula = cell.findtext(NS+'f', '')
                            if formula:
                                value = f'{value} [={formula}]' if value else '='+formula
                            if value.strip():
                                cells.append(cell.get('r', '?')+'='+value)
                        if cells:
                            if len(rows) == 80:
                                warnings.append(name+'：只读取前 80 个非空行')
                                break
                            if len(cells) > 30:
                                warnings.append(name+'：部分行只读取前 30 个非空单元格')
                            rows.append(' | '.join(cells[:30]))
                    blocks.append('工作表：'+name+'\n'+'\n'.join(rows))
                text = '\n\n'.join(blocks)
                candidates = sorted(name for name in seen if name.startswith('xl/media/') and pathlib.PurePosixPath(name).suffix.lower() in IMAGE_EXTS)
                result['imageCount'] = len(candidates)
                for name in candidates[:image_limit]:
                    images.append({'name': pathlib.PurePosixPath(name).name, 'data': base64.b64encode(archive.read(name)).decode('ascii')})
                if len(candidates) > image_limit:
                    warnings.append(f'表格含 {len(candidates)} 张内嵌图片，本次最多读取前 {image_limit} 张')
            else:
                raise ValueError('不支持的文档格式')
    text = text.strip()
    result['truncated'] = len(text) > TEXT_LIMIT
    if result['truncated']:
        warnings.append('正文只保留前 12000 字')
    result['text'] = text[:TEXT_LIMIT]
    result['warnings'] = list(dict.fromkeys(warnings))[:32]
    return result


if __name__ == '__main__':
    try:
        source, kind, limit = sys.argv[1:]
        if source == '-':
            source = sys.stdin.buffer.read(20 * 1024**2 + 1)
        if (len(source) if isinstance(source, bytes) else pathlib.Path(source).stat().st_size) > 20 * 1024**2 or not 0 <= int(limit) <= 20:
            raise ValueError('文档超过 20MB 或图片数量无效')
        print(json.dumps(parse(source, kind, int(limit)), ensure_ascii=True))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError, RuntimeError, NotImplementedError):
        print(json.dumps({'error': '文档无法安全读取，请检查格式、压缩包结构及编码；旧版 Word/Excel 请另存为 DOCX/XLSX'}))
        sys.exit(1)
