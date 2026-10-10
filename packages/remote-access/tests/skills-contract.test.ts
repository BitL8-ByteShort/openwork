import {test,expect} from 'vitest';import {assertContract} from '../src/contract/index.js';
const revision='a'.repeat(64),item={id:'skill_'+revision,name:'synthetic-skill',description:'Synthetic instructions',source:'workspace',editable:true,selectable:true,revision};
test('skills use closed path-free catalog and detail contracts',()=>{
 expect(assertContract('SkillCatalog',{items:[item],revision})).toEqual({items:[item],revision});
 expect(assertContract('SkillDetail',{item,content:'---\nname: synthetic-skill\n---\nInstructions'})).toBeDefined();
 for(const value of [{items:[{...item,path:'/private/source'}],revision},{items:[{...item,source:'arbitrary'}],revision},{items:[{...item,revision:'old'}],revision}])expect(()=>assertContract('SkillCatalog',value)).toThrow();
});
test('skill commands close every field and use explicit conditional revision',()=>{
 const body={requestId:'00000000-0000-4000-8000-000000000001',name:'synthetic-skill',content:'Instructions',revision:null,catalogRevision:revision};expect(assertContract('SkillSave',body)).toBeDefined();
 expect(()=>assertContract('SkillSave',{...body,name:'../path'})).toThrow();expect(()=>assertContract('SkillSave',{...body,shell:'unsafe'})).toThrow();
 expect(assertContract('SkillDelete',{requestId:body.requestId,id:item.id,revision})).toBeDefined();
});
