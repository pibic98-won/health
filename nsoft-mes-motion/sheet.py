import os,sys
from PIL import Image, ImageDraw
d=sys.argv[1] if len(sys.argv)>1 else '.'
files=sorted([f for f in os.listdir(d) if f.startswith('still_')], key=lambda f: float(f[6:-4]))
for k in range(0,len(files),6):
    sheet=Image.new('RGB',(1920,1620),'gray')
    for i,f in enumerate(files[k:k+6]):
        im=Image.open(os.path.join(d,f)).convert('RGB').resize((960,540))
        ImageDraw.Draw(im).text((8,8),f[6:-4]+'s',fill='yellow')
        sheet.paste(im,((i%2)*960,(i//2)*540))
    sheet.save(os.path.join(d,f'sheet{k//6}.jpg'),quality=85)
