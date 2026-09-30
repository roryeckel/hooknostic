const require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);
var Ce=Object.create;var k=Object.defineProperty;var $e=Object.getOwnPropertyDescriptor;var Te=Object.getOwnPropertyNames;var qe=Object.getPrototypeOf,Ne=Object.prototype.hasOwnProperty;var h=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(n,t)=>(typeof require<"u"?require:n)[t]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var f=(e,n)=>()=>{try{return n||e((n={exports:{}}).exports,n),n.exports}catch(t){throw n=0,t}};var Oe=(e,n,t,r)=>{if(n&&typeof n=="object"||typeof n=="function")for(let s of Te(n))!Ne.call(e,s)&&s!==t&&k(e,s,{get:()=>n[s],enumerable:!(r=$e(n,s))||r.enumerable});return e};var j=(e,n,t)=>(t=e!=null?Ce(qe(e)):{},Oe(n||!e||!e.__esModule?k(t,"default",{value:e,enumerable:!0}):t,e));var H=f((an,F)=>{F.exports=z;z.sync=be;var I=h("fs");function Pe(e,n){var t=n.pathExt!==void 0?n.pathExt:process.env.PATHEXT;if(!t||(t=t.split(";"),t.indexOf("")!==-1))return!0;for(var r=0;r<t.length;r++){var s=t[r].toLowerCase();if(s&&e.substr(-s.length).toLowerCase()===s)return!0}return!1}function R(e,n,t){return!e.isSymbolicLink()&&!e.isFile()?!1:Pe(n,t)}function z(e,n,t){I.stat(e,function(r,s){t(r,r?!1:R(s,e,n))})}function be(e,n){return R(I.statSync(e),e,n)}});var G=f((fn,_)=>{_.exports=M;M.sync=Ae;var L=h("fs");function M(e,n,t){L.stat(e,function(r,s){t(r,r?!1:W(s,n))})}function Ae(e,n){return W(L.statSync(e),n)}function W(e,n){return e.isFile()&&ke(e,n)}function ke(e,n){var t=e.mode,r=e.uid,s=e.gid,o=n.uid!==void 0?n.uid:process.getuid&&process.getuid(),c=n.gid!==void 0?n.gid:process.getgid&&process.getgid(),i=parseInt("100",8),a=parseInt("010",8),u=parseInt("001",8),p=i|a,l=t&u||t&a&&s===c||t&i&&r===o||t&p&&o===0;return l}});var X=f((mn,D)=>{var ln=h("fs"),y;process.platform==="win32"||global.TESTING_WINDOWS?y=H():y=G();D.exports=g;g.sync=je;function g(e,n,t){if(typeof n=="function"&&(t=n,n={}),!t){if(typeof Promise!="function")throw new TypeError("callback not provided");return new Promise(function(r,s){g(e,n||{},function(o,c){o?s(o):r(c)})})}y(e,n||{},function(r,s){r&&(r.code==="EACCES"||n&&n.ignoreErrors)&&(r=null,s=!1),t(r,s)})}function je(e,n){try{return y.sync(e,n||{})}catch(t){if(n&&n.ignoreErrors||t.code==="EACCES")return!1;throw t}}});var Q=f((pn,J)=>{var E=process.platform==="win32"||process.env.OSTYPE==="cygwin"||process.env.OSTYPE==="msys",B=h("path"),Ie=E?";":":",K=X(),U=e=>Object.assign(new Error(`not found: ${e}`),{code:"ENOENT"}),Y=(e,n)=>{let t=n.colon||Ie,r=e.match(/\//)||E&&e.match(/\\/)?[""]:[...E?[process.cwd()]:[],...(n.path||process.env.PATH||"").split(t)],s=E?n.pathExt||process.env.PATHEXT||".EXE;.CMD;.BAT;.COM":"",o=E?s.split(t):[""];return E&&e.indexOf(".")!==-1&&o[0]!==""&&o.unshift(""),{pathEnv:r,pathExt:o,pathExtExe:s}},V=(e,n,t)=>{typeof n=="function"&&(t=n,n={}),n||(n={});let{pathEnv:r,pathExt:s,pathExtExe:o}=Y(e,n),c=[],i=u=>new Promise((p,l)=>{if(u===r.length)return n.all&&c.length?p(c):l(U(e));let m=r[u],w=/^".*"$/.test(m)?m.slice(1,-1):m,d=B.join(w,e),v=!w&&/^\.[\\\/]/.test(e)?e.slice(0,2)+d:d;p(a(v,u,0))}),a=(u,p,l)=>new Promise((m,w)=>{if(l===s.length)return m(i(p+1));let d=s[l];K(u+d,{pathExt:o},(v,Se)=>{if(!v&&Se)if(n.all)c.push(u+d);else return m(u+d);return m(a(u,p,l+1))})});return t?i(0).then(u=>t(null,u),t):i(0)},Re=(e,n)=>{n=n||{};let{pathEnv:t,pathExt:r,pathExtExe:s}=Y(e,n),o=[];for(let c=0;c<t.length;c++){let i=t[c],a=/^".*"$/.test(i)?i.slice(1,-1):i,u=B.join(a,e),p=!a&&/^\.[\\\/]/.test(e)?e.slice(0,2)+u:u;for(let l=0;l<r.length;l++){let m=p+r[l];try{if(K.sync(m,{pathExt:s}))if(n.all)o.push(m);else return m}catch{}}}if(n.all&&o.length)return o;if(n.nothrow)return null;throw U(e)};J.exports=V;V.sync=Re});var ee=f((hn,S)=>{"use strict";var Z=(e={})=>{let n=e.env||process.env;return(e.platform||process.platform)!=="win32"?"PATH":Object.keys(n).reverse().find(r=>r.toUpperCase()==="PATH")||"Path"};S.exports=Z;S.exports.default=Z});var se=f((dn,re)=>{"use strict";var ne=h("path"),ze=Q(),Fe=ee();function te(e,n){let t=e.options.env||process.env,r=process.cwd(),s=e.options.cwd!=null,o=s&&process.chdir!==void 0&&!process.chdir.disabled;if(o)try{process.chdir(e.options.cwd)}catch{}let c;try{c=ze.sync(e.command,{path:t[Fe({env:t})],pathExt:n?ne.delimiter:void 0})}catch{}finally{o&&process.chdir(r)}return c&&(c=ne.resolve(s?e.options.cwd:"",c)),c}function He(e){return te(e)||te(e,!0)}re.exports=He});var T=f((En,$)=>{"use strict";var C=/([()\][%!^"`<>&|;, *?])/g;function Le(e){return e=e.replace(C,"^$1"),e}function Me(e,n){return e=`${e}`,e=e.replace(/(?=(\\+?)?)\1"/g,'$1$1\\"'),e=e.replace(/(?=(\\+?)?)\1$/,"$1$1"),e=`"${e}"`,e=e.replace(C,"^$1"),n&&(e=e.replace(C,"^$1")),e}$.exports.command=Le;$.exports.argument=Me});var ce=f((xn,oe)=>{"use strict";oe.exports=/^#!(.*)/});var ue=f((wn,ie)=>{"use strict";var We=ce();ie.exports=(e="")=>{let n=e.match(We);if(!n)return null;let[t,r]=n[0].replace(/#! ?/,"").split(" "),s=t.split("/").pop();return s==="env"?r:r?`${s} ${r}`:s}});var fe=f((yn,ae)=>{"use strict";var q=h("fs"),_e=ue();function Ge(e){let t=Buffer.alloc(150),r;try{r=q.openSync(e,"r"),q.readSync(r,t,0,150,0),q.closeSync(r)}catch{}return _e(t.toString())}ae.exports=Ge});var he=f((vn,pe)=>{"use strict";var De=h("path"),le=se(),me=T(),Xe=fe(),Be=process.platform==="win32",Ke=/\.(?:com|exe)$/i,Ue=/node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;function Ye(e){e.file=le(e);let n=e.file&&Xe(e.file);return n?(e.args.unshift(e.file),e.command=n,le(e)):e.file}function Ve(e){if(!Be)return e;let n=Ye(e),t=!Ke.test(n);if(e.options.forceShell||t){let r=Ue.test(n);e.command=De.normalize(e.command),e.command=me.command(e.command),e.args=e.args.map(o=>me.argument(o,r));let s=[e.command].concat(e.args).join(" ");e.args=["/d","/s","/c",`"${s}"`],e.command=process.env.comspec||"cmd.exe",e.options.windowsVerbatimArguments=!0}return e}function Je(e,n,t){n&&!Array.isArray(n)&&(t=n,n=null),n=n?n.slice(0):[],t=Object.assign({},t);let r={command:e,args:n,options:t,file:void 0,original:{command:e,args:n}};return t.shell?r:Ve(r)}pe.exports=Je});var xe=f((gn,Ee)=>{"use strict";var N=process.platform==="win32";function O(e,n){return Object.assign(new Error(`${n} ${e.command} ENOENT`),{code:"ENOENT",errno:"ENOENT",syscall:`${n} ${e.command}`,path:e.command,spawnargs:e.args})}function Qe(e,n){if(!N)return;let t=e.emit;e.emit=function(r,s){if(r==="exit"){let o=de(s,n);if(o)return t.call(e,"error",o)}return t.apply(e,arguments)}}function de(e,n){return N&&e===1&&!n.file?O(n.original,"spawn"):null}function Ze(e,n){return N&&e===1&&!n.file?O(n.original,"spawnSync"):null}Ee.exports={hookChildProcess:Qe,verifyENOENT:de,verifyENOENTSync:Ze,notFoundError:O}});var ve=f((Sn,x)=>{"use strict";var we=h("child_process"),P=he(),b=xe();function ye(e,n,t){let r=P(e,n,t),s=we.spawn(r.command,r.args,r.options);return b.hookChildProcess(s,r),s}function en(e,n,t){let r=P(e,n,t),s=we.spawnSync(r.command,r.args,r.options);return s.error=s.error||b.verifyENOENTSync(s.status,r),s}x.exports=ye;x.exports.spawn=ye;x.exports.sync=en;x.exports._parse=P;x.exports._enoent=b});var ge=j(ve()),A=j(T());import{spawn as nn}from"node:child_process";import{normalize as tn}from"node:path";function rn({cwd:e,command:n,args:t,env:r}){let s=r===void 0?{cwd:e,stdio:"inherit"}:{cwd:e,stdio:"inherit",env:r},o=ge.default._parse(n,t,s);if(process.platform==="win32"&&/\.(cmd|bat)$/i.test(o.file??"")){let i=[A.default.command(tn(o.file)),...t.map(a=>A.default.argument(a,!0))].join(" ");o.args=["/d","/s","/c",'"'+i+'"']}let c=nn(o.command,o.args,o.options);for(let i of["SIGINT","SIGTERM"])process.on(i,()=>c.kill(i));c.on("error",i=>{console.error(i.message),process.exitCode=1}),c.on("exit",(i,a)=>{a?(process.removeAllListeners(a),process.kill(process.pid,a)):process.exitCode=i??1})}var[sn,on,...cn]=process.argv.slice(2);rn({cwd:sn,command:on,args:cn});

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

hooknostic@0.3.0
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
