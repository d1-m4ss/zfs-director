// JSDOM has no top layer. Native modality/focus/geometry are tested in Chromium.
export function installDialogs(window){
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
}
