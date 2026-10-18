/** Syntax-only transport repair. No fields, claims or answer values are invented. */
export interface ReflectionJson {
  readonly content: string;
  readonly repairs: readonly ('invalid-backslash-escape' | 'extra-object-closers')[];
}
export function reflectionJson(content: string): ReflectionJson {
  const source = content.replace(/^\s*```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try { JSON.parse(source); return {content:source,repairs:[]}; } catch { /* inspect syntax */ }
  const repairs: ReflectionJson['repairs'][number][] = [];
  let quoted=false, escaped=false, result='';
  for(let i=0;i<source.length;i++) {
    const c=source[i]!;
    if(quoted && !escaped && c==='\\') {
      const next=source[i+1];
      const unicode=next==='u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i+2,i+6));
      if(next!==undefined && (!'"\\/bfnrtu'.includes(next) || (next==='u' && !unicode))) {
        result+='\\\\';
        if(!repairs.includes('invalid-backslash-escape')) repairs.push('invalid-backslash-escape');
        continue;
      }
    }
    result+=c;
    if(escaped){escaped=false;continue;}
    if(quoted && c==='\\'){escaped=true;continue;}
    if(c==='"')quoted=!quoted;
  }
  // Remove only redundant object closers after a complete root object. A second
  // object, prose, truncated strings and mismatched interior delimiters fail.
  let end=-1; quoted=false;escaped=false;
  const stack:string[]=[];
  const start=result.search(/\S/);
  if(result[start]==='{') for(let i=start;i<result.length;i++) {
    const c=result[i]!;
    if(escaped){escaped=false;continue;}
    if(quoted && c==='\\'){escaped=true;continue;}
    if(c==='"'){quoted=!quoted;continue;}
    if(quoted)continue;
    if(c==='{' || c==='[')stack.push(c);
    else if(c==='}' || c===']') {
      if(stack.pop()!==(c==='}'?'{':'['))break;
      if(stack.length===0){end=i+1;break;}
    }
  }
  if(end>=0 && /^\s*}(?:\s*})*\s*$/.test(result.slice(end))) {
    result=result.slice(0,end);
    repairs.push('extra-object-closers');
  }
  // Never return a partial or still-invalid repair.
  JSON.parse(result);
  return {content:result,repairs};
}
