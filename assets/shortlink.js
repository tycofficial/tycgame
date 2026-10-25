import {parseRunRoute,encodeRunDescriptor} from './shared.js';
export async function openShortlink(base){
  const current=new URL(location.href);const route=parseRunRoute(current,base);
  // Preserve a manager-provided route on refresh. This state contains no token;
  // copied URLs remain independently resolvable from their path alone.
  const previous=history.state?.tycgameRoute;
  const compatible=previous?.slug===route.slug && previous.shortPath===route.shortPath && previous.connection?.mode===route.connection.mode && (route.connection.mode==='local' || (previous.connection.owner===route.connection.owner && previous.connection.repo===route.connection.repo && previous.connection.branch===route.connection.branch));
  if(compatible){if(previous.entry)route.entry=previous.entry;if(previous.name)route.name=previous.name;}
  const url=new URL(base+'run.html',current.origin);
  const fragment=new URLSearchParams({route:encodeRunDescriptor(route,base)});
  const session=compatible?history.state?.tycgameSession:null;if(/^[a-f0-9]{64}$/.test(session||''))fragment.set('session',session);
  url.hash=fragment.toString();location.replace(url.href);
}
