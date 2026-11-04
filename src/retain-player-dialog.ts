// A browser can drop a native dialog's top-layer state while its page is hidden.
// Restore the existing dialog, without recreating the player or changing the URL.
export function retainPlayerDialog(dialog:HTMLDialogElement,page:Document=document,viewport:Window=window) {
  const restore=()=>{
    if(page.visibilityState==='visible'&&dialog.isConnected&&!dialog.open)dialog.showModal();
  };
  dialog.showModal();
  page.addEventListener('visibilitychange',restore);
  page.addEventListener('resume',restore);
  viewport.addEventListener('pageshow',restore);
  return()=>{
    page.removeEventListener('visibilitychange',restore);
    page.removeEventListener('resume',restore);
    viewport.removeEventListener('pageshow',restore);
    dialog.close();
  };
}
