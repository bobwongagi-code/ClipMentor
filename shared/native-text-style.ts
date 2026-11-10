/** One renderer contract, shared with the executor; not a product-specific visual preset. */
export const NATIVE_TEXT_STYLE_VERSION='native-text-style-v2';
export const NATIVE_TEXT_PROPS=['text','fontSize','fontWeight','color','align','paddingX','backgroundColor','backgroundOpacity','textShadow','shadow'] as const;
export function nativeTextStyle(props:Record<string,unknown>){
 const color=typeof props.backgroundColor==='string'?props.backgroundColor:undefined;
 const alpha=typeof props.backgroundOpacity==='number'&&Number.isFinite(props.backgroundOpacity)?Math.max(0,Math.min(1,props.backgroundOpacity)):1;
 return {color:String(props.color??'#ffffff'),fontSize:Number(props.fontSize??96),fontWeight:Number(props.fontWeight??700),
  backgroundColor:color&&alpha<1?`color-mix(in srgb, ${color} ${alpha*100}%, transparent)`:color,
  textShadow:typeof props.textShadow==='string'?props.textShadow:props.shadow===0?'none':'0 3px 16px rgba(0,0,0,0.55)'};
}
