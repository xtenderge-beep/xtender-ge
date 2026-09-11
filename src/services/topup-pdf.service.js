const PDFDocument=require('pdfkit');
const path=require('path');
const {translate}=require('../config/i18n');
const {purpose}=require('./topup.service');
const brand=require('../config/brand');
const fonts=path.join(__dirname,'../../assets/fonts');
function generate(topup,lang='ka') {
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:42,info:{Title:topup.reference,Author:'Xtender'}});
  const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const t=translate(lang),r=topup.recipient,left=42,width=511;
  function font(value,bold=false){return path.join(fonts,/\p{Script=Georgian}/u.test(value)?'NotoSansGeorgian-Regular.ttf':bold?'NotoSans-Bold.ttf':'NotoSans-Regular.ttf');}
  function text(value,x,y,w,size=10,color=brand.ink,bold=false){
   const runs=String(value).split(/(\p{Script=Georgian}+)/u).filter(Boolean);doc.x=x;doc.y=y;
   runs.forEach((run,i)=>doc.font(font(run,bold)).fontSize(size).fillColor(color).text(run,{width:w,lineGap:2,continued:i<runs.length-1}));return doc.y;
  }
  function height(value,w,size){return Math.max(...['NotoSans-Regular.ttf','NotoSansGeorgian-Regular.ttf'].map(f=>doc.font(path.join(fonts,f)).fontSize(size).heightOfString(String(value),{width:w,lineGap:2})))+4;}
  function logo(x,y){
   doc.save().translate(x,y).scale(.625);doc.roundedRect(0,0,64,64,17).fill(brand.ink);brand.paths.forEach(p=>doc.path(p.d).fill(p.fill));doc.restore();
   text('xtender',x+51,y+6,135,22,brand.ink,true);const w=doc.font(font('xtender',true)).fontSize(22).widthOfString('xtender');text('.ge',x+51+w,y+6,45,22,'#488153',true);
  }
  logo(left,40);text('GEL / '+lang.toUpperCase(),453,54,100,9,'#68776d');
  text(t('pay_document'),left,108,width,19);text(t('pay_not_receipt'),left,143,width,8,'#6a776c');
  doc.roundedRect(left,180,width,77,12).fill(brand.paper);
  text(t('pay_reference'),left+18,194,270,8,'#677568');text(topup.reference,left+18,211,280,16,brand.ink,true);
  text(t('pay_amount').replace(', ₾',''),left+330,194,160,8,'#677568');text((topup.amount_tetri/100).toFixed(2)+' GEL',left+330,211,164,20,brand.ink,true);
  let y=282;
  function row(key,value,emphasis=false){
   const w=width-150,h=Math.max(26,height(value,w,emphasis?11:9.5)+13,height(t(key),130,8)+13);
   if(y+h>735){doc.addPage();logo(left,32);y=95;}
   doc.moveTo(left,y).lineTo(left+width,y).lineWidth(.5).strokeColor('#dce4d8').stroke();text(t(key),left,y+9,130,8,'#6b776d');
   const end=text(value,left+150,y+8,w,emphasis?11:9.5,brand.ink,emphasis);y=Math.max(y+h,end+9);
  }
  row('pay_date',new Date(topup.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Tbilisi'}));row('pay_payer',topup.payer_name);row('pay_recipient',r.RECIPIENT_NAME);row('pay_id',r.RECIPIENT_ID);row('pay_address',r.RECIPIENT_ADDRESS);row('pay_bank',r.BANK_NAME);row('pay_iban',r.BANK_ACCOUNT,true);row('pay_swift',r.SWIFT);row('pay_purpose',purpose(topup),true);row('pay_vat',r.VAT_NOTE);
  if(topup.status==='credited')row('pay_credited',t('pay_done'));
  if(y+60>785){doc.addPage();y=45;}
  doc.moveTo(left,y+14).lineTo(left+width,y+14).strokeColor('#cdd9c9').stroke();text('xtender.ge',left,y+27,180,9,brand.ink,true);text(r.EMAIL,left+245,y+27,266,9,'#6b776d');doc.end();
 });
}
module.exports={generate};
