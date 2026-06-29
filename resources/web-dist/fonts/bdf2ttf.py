# Convert the Atari ST 8x16 BDF bitmap font to a pixel-perfect TTF/woff2.
# Each lit pixel becomes a filled square outline, so the glyphs sit exactly on
# the integer grid and render crisp at any integer size, in every browser.
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

SRC="/tmp/atarist-font/atarist-normal.bdf"
P=128                      # font units per pixel
UPM=16*P                   # 16px cell -> unitsPerEm 2048
ASCENT=14; DESCENT=2       # from the BDF (FONT_ASCENT/DESCENT)

def parse_bdf(path):
    glyphs=[]; cur=None; reading=False; rows=[]
    for line in open(path, encoding="latin-1"):
        t=line.split()
        if not t: continue
        k=t[0]
        if k=="STARTCHAR": cur={"name":t[1] if len(t)>1 else "?"}
        elif k=="ENCODING": cur["cp"]=int(t[1])
        elif k=="DWIDTH": cur["dw"]=int(t[1])
        elif k=="BBX": cur["bbx"]=list(map(int,t[1:5]))
        elif k=="BITMAP": reading=True; rows=[]
        elif k=="ENDCHAR":
            cur["rows"]=rows; reading=False; glyphs.append(cur); cur=None
        elif reading: rows.append(line.strip())
    return glyphs

def glyph_pen(g):
    pen=TTGlyphPen(None)
    w,h,xoff,yoff=g["bbx"]
    for r,hexrow in enumerate(g["rows"]):
        if not hexrow: continue
        val=int(hexrow,16); nbits=len(hexrow)*4
        # row r is from the top; its baseline-relative pixel band:
        ybot=(yoff+(h-1-r))*P; ytop=ybot+P
        c=0
        while c<w:
            bit=(val>>(nbits-1-c))&1
            if bit:
                c0=c
                while c<w and (val>>(nbits-1-c))&1: c+=1
                x0=(xoff+c0)*P; x1=(xoff+c)*P
                pen.moveTo((x0,ybot)); pen.lineTo((x0,ytop))
                pen.lineTo((x1,ytop)); pen.lineTo((x1,ybot)); pen.closePath()
            else: c+=1
    return pen.glyph()

bdf=parse_bdf(SRC)
order=[".notdef"]; cmap={}; glyfs={}; metrics={}
adv=8*P
glyfs[".notdef"]=TTGlyphPen(None).glyph(); metrics[".notdef"]=(adv,0)
for g in bdf:
    cp=g.get("cp",-1)
    if cp<0: continue
    name="g%04X"%cp if cp>0 else "g0000"
    if name in glyfs: continue
    glyfs[name]=glyph_pen(g); metrics[name]=(g.get("dw",8)*P,0)
    order.append(name)
    if cp>0: cmap[cp]=name

fb=FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupGlyf(glyfs)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=ASCENT*P, descent=-DESCENT*P)
fb.setupNameTable({"familyName":"AtariST","styleName":"Regular",
  "fullName":"Atari ST","psName":"AtariST-Regular",
  "version":"1.0","copyright":"Atari ST system font (ntwk/atarist-font, modelb.bbcmicro.com)"})
fb.setupOS2(sTypoAscender=ASCENT*P, sTypoDescender=-DESCENT*P, usWinAscent=ASCENT*P, usWinDescent=DESCENT*P)
fb.setupPost()
OUT="/Users/oli/Dev/CDP8/wasm/demo/fonts/"
fb.save(OUT+"atari-st.ttf")
fb.font.flavor="woff2"; fb.save(OUT+"atari-st.woff2")
print("glyphs:",len(order),"cmap:",len(cmap))
