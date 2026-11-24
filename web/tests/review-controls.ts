import type { Locator, Page } from '@playwright/test'

type Surface = Page | Locator
export async function acknowledgeOverallFeedback(surface:Surface){
  await surface.getByLabel('反馈位置').selectOption('whole')
  await surface.getByLabel('确认这条意见作用于整体').check()
}

export async function acceptGroups(surface:Surface){
  const groups=surface.getByRole('region',{name:'逐组人审'})
  const decisions=groups.getByRole('textbox')
  const stances=groups.getByRole('combobox')
  for(let index=0;index<await decisions.count();index++){
    await decisions.nth(index).fill('把对照安排在同一画面')
    await stances.nth(index).selectOption('accepted')
  }
  for(const ending of await groups.getByRole('checkbox').all())await ending.check()
}

export async function checkFinalReview(surface:Surface){
  await surface.getByLabel('看过成片',{exact:true}).check()
  await surface.getByLabel('核过马来语',{exact:true}).check()
}

export const approvedFixtureReview = {
  canApproveBlueprint:true,
  reviewGroups:[{id:'fixture-group',label:'第 1 组'}],
  savedReview:{groups:[{id:'fixture-group',decision:'在同一画面保留对照',stance:'accepted'}],endings:[]},
}
