/** Provenance for a provider subtitle sidecar, not a second timeline or an approval. */
export interface MinimaxSubtitleBinding {
 version:1;
 provider:'minimax';
 subtitleType:'word';
 subtitlePath:string;
 subtitleSha256:string;
 audioSha256:string;
 textSha256:string;
 durationSeconds:number;
}

/** Both existing voice hosts persist the same response provenance; no timing is inferred here. */
export function voiceAssetProvenance(result:{sha256?:string;subtitlePath?:string;subtitleBinding?:MinimaxSubtitleBinding},subtitleType?:string){
 return{
  ...(result.sha256?{sourceContentHash:result.sha256}:{}),
  props:{...(result.subtitlePath?{minimaxSubtitlePath:result.subtitlePath,minimaxSubtitleType:subtitleType??'sentence'}:{}),
   ...(result.subtitleBinding?{minimaxSubtitleBinding:result.subtitleBinding}:{})},
 };
}
