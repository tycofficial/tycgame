import {LocalStore} from './local-store.js';
import {validSlug,makeRunURL} from './shared.js';
export async function openShortlink(base){
  const current=new URL(location.href);const paths=current.pathname.slice(base.length).split('/').filter(Boolean);
  const slug=paths[0]==='a'?paths[1]:paths[0];
  if(!validSlug(slug)||paths.length>(paths[0]==='a'?2:1))throw new Error('地址无效');
  let local=false;
  try{const app=await new LocalStore().getApp(slug);local=app.status==='ready';}catch{}
  const connection=local?{mode:'local'}:{mode:'github',owner:current.searchParams.get('owner')||'tycofficial',repo:current.searchParams.get('repo')||'tycgame',branch:current.searchParams.get('branch')||'tycgame-data'};
  location.replace(makeRunURL({id:slug,slug},connection));
}
