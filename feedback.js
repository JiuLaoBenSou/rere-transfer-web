export function createFeedbackDraft({category='',details='',contact='',includeContext=false,browser='',language=''}={}){
 const description=String(details).trim();
 if(!description||description.length>2000)throw new Error('A description of 1–2000 characters is required.');
 const subject='WarmDrop feedback: '+String(category).replace(/[\r\n]/g,' ').slice(0,80);
 const body=[description,contact?'Reply to: '+String(contact).slice(0,200):'',includeContext?'Browser: '+String(browser).slice(0,500)+'\nLanguage: '+String(language).slice(0,20):''].filter(Boolean).join('\n\n');
 return{subject,body,href:'mailto:fanghong1994@gmail.com?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body)};
}

if(typeof document!=='undefined'){
 const {initPage,t,getLanguage}=await import('./i18n.js?v=feedback1');initPage();
 const form=document.querySelector('#feedback-form'),status=document.querySelector('#feedback-status');
 const details=form.elements.details;
 form.addEventListener('input',()=>{details.setCustomValidity('');document.querySelector('#feedback-result').hidden=true;status.textContent='';});
 form.addEventListener('submit',event=>{
  event.preventDefault();
  if(!details.value.trim()){details.setCustomValidity(t('请先描述遇到的问题或建议。'));details.reportValidity();return;}
  if(!form.reportValidity())return;
  const draft=createFeedbackDraft({category:form.elements.category.selectedOptions[0].text,details:details.value,contact:form.elements.contact.value,includeContext:form.elements.context.checked,browser:navigator.userAgent,language:getLanguage()});
  document.querySelector('#feedback-email').href=draft.href;
  document.querySelector('#feedback-preview').value=draft.subject+'\n\n'+draft.body;
  document.querySelector('#feedback-result').hidden=false;
  status.textContent=t('尚未发送。请打开邮件并发送，或复制内容后自行发送。');
  document.querySelector('#feedback-email').focus();
 });
 document.querySelector('#feedback-copy').addEventListener('click',async()=>{
  const preview=document.querySelector('#feedback-preview');
  try{await navigator.clipboard.writeText(preview.value);status.textContent=t('已复制，请粘贴到邮件中发送。');}
  catch{preview.focus();preview.select();status.textContent=t('请手动复制下方内容。');}
 });
}
