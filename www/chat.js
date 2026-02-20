const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');
let contextId = localStorage.getItem('chat-contextId');

function append(role, text){
  const d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  d.textContent = (role === 'user' ? 'You: ' : 'Agent: ') + text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

async function sendMessage(){
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  append('user', text);

  try{
    const res = await fetch('/chat/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, contextId })
    });
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const reply = data.reply;
    if (reply?.contextId) {
      contextId = reply.contextId;
      localStorage.setItem('chat-contextId', contextId);
    }
    const replyText = reply?.parts?.find(p => p.kind === 'text')?.text
      ?? (typeof reply === 'string' ? reply : JSON.stringify(reply));
    append('bot', replyText);
  }catch(err){
    append('bot', 'Error: ' + err.message);
  }
}

send.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') sendMessage(); });

append('bot', 'Welcome — ask the agent a question.');
