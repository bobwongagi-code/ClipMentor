export const BLUEPRINT_OPINION_MAX_LENGTH=4000;
export type BlueprintOpinion = {unitId:string|null;text:string;keepPlacement?:true};
export type BlueprintOpinionPlacement = {index:number;unitId:string|null;label:string;multiple?:true};
export type BlueprintOpinionConfirmation = {token:string;rows:Array<{label:string;keep:string[];change:string}>};
export type BlueprintOpinionDifference = {
 label:string;changes:Array<{before:string;after:string}>;kept:string[];
};
