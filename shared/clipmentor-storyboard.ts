/** Read-only projections of the existing blueprint and saved native timeline. Never author here. */
export interface StoryboardReference {
 key:string;origin:'source'|'supplied_full'|'planned_crop';asset_id:string;source_seconds:number;
 line_ids:string[];crop?:{left:number;top:number;right:number;bottom:number};
}
export interface StoryboardCard {
 id:string;subject_id:string;kind:'unit'|'opening'|'closing';title:string;intent:string;
 lines:Array<{id:string;ms:string;zh:string;captions:string[];labels:string[]}>;
 source:StoryboardReference[];actual:Array<{key:string;frame:number;phase:string}>;
 actual_status:'placed'|'not_placed'|'mapping_unavailable';
 notes:string[];
}
export interface ClipMentorStoryboard {
 project_id:string;project_revision:string;timeline_id:string;analysis_revision:number;blueprint_digest:string;digest:string;
 title:string;cards:StoryboardCard[];copy_gate:{allowed:boolean;code:string};
 authority:'read_only_reference_and_saved_layout_not_approval';continuous_viewing:false;listening:false;
}
export interface StoryboardImages {
 digest:string;card_id:string;part:'source'|'actual';offset:number;next_offset:number|null;
 images:Array<{key:string;status:'available';base64:string;media_type:'image/jpeg';frame?:number;source_seconds?:number;origin?:string}
  |{key:string;status:'unavailable';reason:string}>;
 authority:'sampled_images_not_continuous_review';
}
