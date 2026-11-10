import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';

/** Read the pinned renderer's own cache/platform mapping; never provision it.
 * Keep this package-internal lookup in one place so a renderer update is tested
 * by the actual PDF/crop paths, rather than maintaining another OS path table. */
export function installedRenderBrowserExecutable(){
 if(process.env.CC_BROWSER_EXECUTABLE)return process.env.CC_BROWSER_EXECUTABLE;
 const require=createRequire(import.meta.url);
 const fetcher=require(join(dirname(require.resolve('@remotion/renderer')),'browser','BrowserFetcher.js')) as {getRevisionInfo:(mode:'headless-shell')=>{executablePath:string}};
 return fetcher.getRevisionInfo('headless-shell').executablePath;
}
