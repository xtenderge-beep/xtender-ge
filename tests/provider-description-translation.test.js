const assert=require('node:assert/strict');
process.env.OPENROUTER_API_KEY='test-key';
let failEnglish=false;
require.cache[require.resolve('axios')]={exports:{post:async(url,body)=>{
  assert.match(url,/openrouter\.ai/);
  assert.match(body.messages[0].content,/provider service description/);
  const prompt=body.messages[0].content;
  if(prompt.includes('into English')&&failEnglish) throw Error('translation unavailable');
  return {data:{choices:[{message:{content:prompt.includes('into Georgian')?'ქართული თარგმანი':'English translation'}}]}};
}}};
const translation=require('../src/services/translation.service');
(async()=>{
 const result=await translation.translateProviderDescription('Грузовые работы','ru');
 assert.deepEqual(result,{sourceLang:'ru',translations:{ka:'ქართული თარგმანი',en:'English translation'}});
 failEnglish=true;
 assert.equal(await translation.translateProviderDescription('Новые работы','ru'),null);
 console.log('PASS provider description: OpenRouter translates both target languages; partial failures are rejected.');
})().catch(e=>{console.error(e);process.exitCode=1;});
