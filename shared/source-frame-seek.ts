/** Integer millisecond seeks must not advance a requested source-frame start.
 * Rounding up can select the next frame, including EOF at the final frame. */
export function sourceFrameSeekMs(milliseconds:number):number {
 if(!Number.isFinite(milliseconds)||milliseconds<0)throw new Error('Invalid source frame seek');
 return Math.floor(milliseconds);
}
