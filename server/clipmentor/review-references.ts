type RecordValue = Record<string, unknown>;
export const reviewRecord = (value: unknown): value is RecordValue =>
 !!value && typeof value === 'object' && !Array.isArray(value);

export type ReviewReferenceIssue = {field:string;material:string;value?:string;receipt?:string};

export class ReviewReferenceIssues extends Error {
 readonly issues:ReviewReferenceIssue[];
 constructor(issues:ReviewReferenceIssue[]) {
  super('blueprint_review_reference_invalid: '+JSON.stringify(issues));
  this.issues=issues;
 }
}

/** Only use the supplied, revision-bound material. A selection never creates an evidence relationship. */
export function reviewReferenceResolver() {
 const issues:ReviewReferenceIssue[]=[];
 const missing=(field:string,material:string,value:unknown)=>{
  issues.push({field,material,...(typeof value==='string'?{value:value.slice(0,500)}:{})});
 };
 return {
  issues,missing,
  text(field:string,material:string,id:unknown,options:ReadonlyMap<string,string>){
   const text=typeof id==='string'?options.get(id):undefined;
   if(text===undefined)missing(field,material,id);
   return text;
  },
  assert(){if(issues.length)throw new ReviewReferenceIssues(issues);},
 };
}
