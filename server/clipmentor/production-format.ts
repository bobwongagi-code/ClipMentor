import type {ProjectDoc} from '../../src/editor/types';
import {probeVideo,parseFrameRate} from '../media-normalization';

/** ClipMentor's creator-facing short video, independent of the editor's generic canvas default. */
export const CLIPMENTOR_OUTPUT_CANVAS=Object.freeze({width:720,height:1280});

export function assertProductionDimensions(value:{width?:unknown;height?:unknown}|undefined,scope:string){
 const width=value?.width,height=value?.height;
 if(typeof width!=='number'||typeof height!=='number'||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)
   ||width<=0||height<=0||width*16!==height*9)
  throw Error(`clipmentor_output_canvas_mismatch:${scope}:expected_9x16:actual_${String(width)}x${String(height)}`);
}

export function assertProductionCanvas(doc:ProjectDoc){
 assertProductionDimensions(doc.timelines.find(t=>t.id===doc.activeTimelineId),'saved_timeline');
}

/** Inspect the actual saved file, never the plan or the render request's advertised dimensions. */
export async function verifyProductionOutput(file:string,signal?:AbortSignal){
 const actual=await probeVideo(file,signal);
 assertProductionDimensions(actual,'exported_file');
 // The product exports square-pixel MP4s. Coded dimensions alone do not
 // establish the visible aspect ratio when a file declares anamorphic pixels.
 const pixelRatio=parseFrameRate(actual.sampleAspectRatio?.replace(':','/'))??1;
 if(pixelRatio!==1)throw Error('clipmentor_output_canvas_mismatch:exported_file:expected_square_pixels');
 return {width:actual.width,height:actual.height};
}
