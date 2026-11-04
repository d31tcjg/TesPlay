// API search titles use HTML entities even though their payload is JSON.
export function plainText(value) {
  const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',hellip:'…',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
  return String(value || '').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(raw,entity)=>{
    if(entity[0]!=='#') return named[entity.toLowerCase()] ?? raw;
    const code=parseInt(entity.slice(entity[1].toLowerCase()==='x'?2:1),entity[1].toLowerCase()==='x'?16:10);
    return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff)?String.fromCodePoint(code):raw;
  }).slice(0,12000);
}
export function mediaDate(value) {
  if(value===undefined || value===null || value==='')return undefined;
  const n=Number(value), date=new Date(Number.isFinite(n)?n*(n<1e12?1000:1):value);
  return Number.isFinite(date.getTime())?date.toISOString():undefined;
}
