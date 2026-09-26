const test = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../src/services/serviceRequirements.service');
const matching = require('../src/services/serviceMatching.service');

const categories = [
  {slug:'van',is_active:true,fields:[
    {key:'body',input:'enum',options:['closed','flatbed'],match:'exact'},
    {key:'tail_lift',input:'bool',match:'flag'},
    {key:'capacity',input:'number',min:1,max:20,match:'gte'},
    {key:'note',input:'text',match:'ignore'},
  ]},
  {slug:'movers',is_active:true,fields:[{key:'crew_size',input:'number',min:1,max:20,match:'gte'}]},
];

test('admin requirements use category rules and reject invented values', () => {
  const result = needs.parse(categories,['transport','movers'],{
    transport:{body:'closed',tail_lift:'on',capacity:'8'},movers:{crew_size:'2'},
  });
  assert.deepEqual(result.services.transport,{body:'closed',tail_lift:true,capacity:8});
  assert.deepEqual(result.services.movers,{crew_size:2});
  assert.throws(()=>needs.parse(categories,['transport'],{transport:{capacity:'100'}}),/Некорректная/);
  assert.throws(()=>needs.parse(categories,['transport'],{transport:{note:'anything'}}),/Неизвестная/);
});

test('dispatch excludes providers without every requested capability', () => {
  const requirements = {...needs.parse(categories,['transport','movers'],{
    transport:{body:'closed',tail_lift:'on',capacity:'8'},movers:{crew_size:'2'},
  }),transport_size:'L'};
  const both = [
    {service_type:'van',attributes:{body:'closed',tail_lift:true,capacity:10,size:'L'}},
    {service_type:'movers',attributes:{crew_size:3},requires_own_transport:true},
  ];
  assert.equal(matching.matches(both,'transport','L',['transport','movers'],requirements),true);
  assert.equal(matching.matches(both,'movers','',['transport','movers'],requirements),true);
  assert.equal(matching.matches(both,'movers','',['movers'],requirements),false);
  assert.equal(matching.matches([{...both[0],attributes:{...both[0].attributes,capacity:5}},both[1]],'transport','L',['transport','movers'],requirements),false);
  assert.equal(matching.matches([{...both[0],attributes:{...both[0].attributes,tail_lift:false}},both[1]],'transport','L',['transport','movers'],requirements),false);
});
