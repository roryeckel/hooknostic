const require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);
var qe=Object.create;var I=Object.defineProperty;var Ne=Object.getOwnPropertyDescriptor;var Oe=Object.getOwnPropertyNames;var Pe=Object.getPrototypeOf,be=Object.prototype.hasOwnProperty;var h=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(n,t)=>(typeof require<"u"?require:n)[t]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var u=(e,n)=>()=>(n||e((n={exports:{}}).exports,n),n.exports);var Ae=(e,n,t,r)=>{if(n&&typeof n=="object"||typeof n=="function")for(let s of Oe(n))!be.call(e,s)&&s!==t&&I(e,s,{get:()=>n[s],enumerable:!(r=Ne(n,s))||r.enumerable});return e};var R=(e,n,t)=>(t=e!=null?qe(Pe(e)):{},Ae(n||!e||!e.__esModule?I(t,"default",{value:e,enumerable:!0}):t,e));var M=u((ln,L)=>{L.exports=H;H.sync=je;var z=h("fs");function ke(e,n){var t=n.pathExt!==void 0?n.pathExt:process.env.PATHEXT;if(!t||(t=t.split(";"),t.indexOf("")!==-1))return!0;for(var r=0;r<t.length;r++){var s=t[r].toLowerCase();if(s&&e.substr(-s.length).toLowerCase()===s)return!0}return!1}function F(e,n,t){return!e.isSymbolicLink()&&!e.isFile()?!1:ke(n,t)}function H(e,n,t){z.stat(e,function(r,s){t(r,r?!1:F(s,e,n))})}function je(e,n){return F(z.statSync(e),e,n)}});var X=u((mn,D)=>{D.exports=_;_.sync=Ie;var W=h("fs");function _(e,n,t){W.stat(e,function(r,s){t(r,r?!1:G(s,n))})}function Ie(e,n){return G(W.statSync(e),n)}function G(e,n){return e.isFile()&&Re(e,n)}function Re(e,n){var t=e.mode,r=e.uid,s=e.gid,o=n.uid!==void 0?n.uid:process.getuid&&process.getuid(),c=n.gid!==void 0?n.gid:process.getgid&&process.getgid(),a=parseInt("100",8),p=parseInt("010",8),i=parseInt("001",8),m=a|p,f=t&i||t&p&&s===c||t&a&&r===o||t&m&&o===0;return f}});var K=u((hn,B)=>{var pn=h("fs"),v;process.platform==="win32"||global.TESTING_WINDOWS?v=M():v=X();B.exports=S;S.sync=ze;function S(e,n,t){if(typeof n=="function"&&(t=n,n={}),!t){if(typeof Promise!="function")throw new TypeError("callback not provided");return new Promise(function(r,s){S(e,n||{},function(o,c){o?s(o):r(c)})})}v(e,n||{},function(r,s){r&&(r.code==="EACCES"||n&&n.ignoreErrors)&&(r=null,s=!1),t(r,s)})}function ze(e,n){try{return v.sync(e,n||{})}catch(t){if(n&&n.ignoreErrors||t.code==="EACCES")return!1;throw t}}});var ee=u((dn,Z)=>{var E=process.platform==="win32"||process.env.OSTYPE==="cygwin"||process.env.OSTYPE==="msys",U=h("path"),Fe=E?";":":",Y=K(),V=e=>Object.assign(new Error(`not found: ${e}`),{code:"ENOENT"}),J=(e,n)=>{let t=n.colon||Fe,r=e.match(/\//)||E&&e.match(/\\/)?[""]:[...E?[process.cwd()]:[],...(n.path||process.env.PATH||"").split(t)],s=E?n.pathExt||process.env.PATHEXT||".EXE;.CMD;.BAT;.COM":"",o=E?s.split(t):[""];return E&&e.indexOf(".")!==-1&&o[0]!==""&&o.unshift(""),{pathEnv:r,pathExt:o,pathExtExe:s}},Q=(e,n,t)=>{typeof n=="function"&&(t=n,n={}),n||(n={});let{pathEnv:r,pathExt:s,pathExtExe:o}=J(e,n),c=[],a=i=>new Promise((m,f)=>{if(i===r.length)return n.all&&c.length?m(c):f(V(e));let l=r[i],y=/^".*"$/.test(l)?l.slice(1,-1):l,d=U.join(y,e),g=!y&&/^\.[\\\/]/.test(e)?e.slice(0,2)+d:d;m(p(g,i,0))}),p=(i,m,f)=>new Promise((l,y)=>{if(f===s.length)return l(a(m+1));let d=s[f];Y(i+d,{pathExt:o},(g,Te)=>{if(!g&&Te)if(n.all)c.push(i+d);else return l(i+d);return l(p(i,m,f+1))})});return t?a(0).then(i=>t(null,i),t):a(0)},He=(e,n)=>{n=n||{};let{pathEnv:t,pathExt:r,pathExtExe:s}=J(e,n),o=[];for(let c=0;c<t.length;c++){let a=t[c],p=/^".*"$/.test(a)?a.slice(1,-1):a,i=U.join(p,e),m=!p&&/^\.[\\\/]/.test(e)?e.slice(0,2)+i:i;for(let f=0;f<r.length;f++){let l=m+r[f];try{if(Y.sync(l,{pathExt:s}))if(n.all)o.push(l);else return l}catch{}}}if(n.all&&o.length)return o;if(n.nothrow)return null;throw V(e)};Z.exports=Q;Q.sync=He});var te=u((En,C)=>{"use strict";var ne=(e={})=>{let n=e.env||process.env;return(e.platform||process.platform)!=="win32"?"PATH":Object.keys(n).reverse().find(r=>r.toUpperCase()==="PATH")||"Path"};C.exports=ne;C.exports.default=ne});var ce=u((xn,oe)=>{"use strict";var re=h("path"),Le=ee(),Me=te();function se(e,n){let t=e.options.env||process.env,r=process.cwd(),s=e.options.cwd!=null,o=s&&process.chdir!==void 0&&!process.chdir.disabled;if(o)try{process.chdir(e.options.cwd)}catch{}let c;try{c=Le.sync(e.command,{path:t[Me({env:t})],pathExt:n?re.delimiter:void 0})}catch{}finally{o&&process.chdir(r)}return c&&(c=re.resolve(s?e.options.cwd:"",c)),c}function We(e){return se(e)||se(e,!0)}oe.exports=We});var q=u((wn,T)=>{"use strict";var $=/([()\][%!^"`<>&|;, *?])/g;function _e(e){return e=e.replace($,"^$1"),e}function Ge(e,n){return e=`${e}`,e=e.replace(/(?=(\\+?)?)\1"/g,'$1$1\\"'),e=e.replace(/(?=(\\+?)?)\1$/,"$1$1"),e=`"${e}"`,e=e.replace($,"^$1"),n&&(e=e.replace($,"^$1")),e}T.exports.command=_e;T.exports.argument=Ge});var ue=u((yn,ie)=>{"use strict";ie.exports=/^#!(.*)/});var fe=u((vn,ae)=>{"use strict";var De=ue();ae.exports=(e="")=>{let n=e.match(De);if(!n)return null;let[t,r]=n[0].replace(/#! ?/,"").split(" "),s=t.split("/").pop();return s==="env"?r:r?`${s} ${r}`:s}});var me=u((gn,le)=>{"use strict";var N=h("fs"),Xe=fe();function Be(e){let t=Buffer.alloc(150),r;try{r=N.openSync(e,"r"),N.readSync(r,t,0,150,0),N.closeSync(r)}catch{}return Xe(t.toString())}le.exports=Be});var Ee=u((Sn,de)=>{"use strict";var Ke=h("path"),pe=ce(),he=q(),Ue=me(),Ye=process.platform==="win32",Ve=/\.(?:com|exe)$/i,Je=/node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;function Qe(e){e.file=pe(e);let n=e.file&&Ue(e.file);return n?(e.args.unshift(e.file),e.command=n,pe(e)):e.file}function Ze(e){if(!Ye)return e;let n=Qe(e),t=!Ve.test(n);if(e.options.forceShell||t){let r=Je.test(n);e.command=Ke.normalize(e.command),e.command=he.command(e.command),e.args=e.args.map(o=>he.argument(o,r));let s=[e.command].concat(e.args).join(" ");e.args=["/d","/s","/c",`"${s}"`],e.command=process.env.comspec||"cmd.exe",e.options.windowsVerbatimArguments=!0}return e}function en(e,n,t){n&&!Array.isArray(n)&&(t=n,n=null),n=n?n.slice(0):[],t=Object.assign({},t);let r={command:e,args:n,options:t,file:void 0,original:{command:e,args:n}};return t.shell?r:Ze(r)}de.exports=en});var ye=u((Cn,we)=>{"use strict";var O=process.platform==="win32";function P(e,n){return Object.assign(new Error(`${n} ${e.command} ENOENT`),{code:"ENOENT",errno:"ENOENT",syscall:`${n} ${e.command}`,path:e.command,spawnargs:e.args})}function nn(e,n){if(!O)return;let t=e.emit;e.emit=function(r,s){if(r==="exit"){let o=xe(s,n);if(o)return t.call(e,"error",o)}return t.apply(e,arguments)}}function xe(e,n){return O&&e===1&&!n.file?P(n.original,"spawn"):null}function tn(e,n){return O&&e===1&&!n.file?P(n.original,"spawnSync"):null}we.exports={hookChildProcess:nn,verifyENOENT:xe,verifyENOENTSync:tn,notFoundError:P}});var Se=u(($n,x)=>{"use strict";var ve=h("child_process"),b=Ee(),A=ye();function ge(e,n,t){let r=b(e,n,t),s=ve.spawn(r.command,r.args,r.options);return A.hookChildProcess(s,r),s}function rn(e,n,t){let r=b(e,n,t),s=ve.spawnSync(r.command,r.args,r.options);return s.error=s.error||A.verifyENOENTSync(s.status,r),s}x.exports=ge;x.exports.spawn=ge;x.exports.sync=rn;x.exports._parse=b;x.exports._enoent=A});var Ce=R(Se()),k=R(q());import{spawn as sn}from"node:child_process";import{normalize as on}from"node:path";var[cn,un,...$e]=process.argv.slice(2),an={cwd:cn,stdio:"inherit"},w=Ce.default._parse(un,$e,an);if(process.platform==="win32"&&/\.(cmd|bat)$/i.test(w.file??"")){let e=[k.default.command(on(w.file)),...$e.map(n=>k.default.argument(n,!0))].join(" ");w.args=["/d","/s","/c",'"'+e+'"']}var j=sn(w.command,w.args,w.options);for(let e of["SIGINT","SIGTERM"])process.on(e,()=>j.kill(e));j.on("error",e=>{console.error(e.message),process.exitCode=1});j.on("exit",(e,n)=>{n?(process.removeAllListeners(n),process.kill(process.pid,n)):process.exitCode=e??1});

/*!
Bundled package notices

cross-spawn@7.0.6
LICENSE
The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

hooknostic@0.1.0
LICENSE
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

---

isexe@2.0.0
which@2.0.2
LICENSE
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

path-key@3.1.1
shebang-regex@3.0.0
license
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

shebang-command@2.0.0
license
MIT License

Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
